package main

// File and folder details for the properties dialog (#198). The cheap fields
// join the stat reply; the heavy ones (folder size, checksum, media) run only
// when asked, as the user, and stop at a deadline instead of holding a worker
// thread on a huge tree or file.

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
	"golang.org/x/sys/unix"
)

// detailsDeadline bounds every on-demand detail; the backend waits a little longer.
const detailsDeadline = 90 * time.Second

// statExtras are the cheap fields added to the stat reply.
type statExtras struct {
	Atime      string `json:"atime,omitempty"`
	Btime      string `json:"btime,omitempty"`
	Nlink      uint64 `json:"nlink"`
	LinkTarget string `json:"linkTarget,omitempty"`
	Mime       string `json:"mime,omitempty"`
}

func fillStatExtras(path string, info os.FileInfo, sys *syscall.Stat_t) statExtras {
	ex := statExtras{
		Atime: time.Unix(sys.Atim.Sec, sys.Atim.Nsec).UTC().Format(time.RFC3339),
		Nlink: uint64(sys.Nlink),
	}
	// Birth time only exists on filesystems that record it (ext4, xfs, btrfs).
	var stx unix.Statx_t
	if err := unix.Statx(unix.AT_FDCWD, path, unix.AT_SYMLINK_NOFOLLOW, unix.STATX_BTIME, &stx); err == nil && stx.Mask&unix.STATX_BTIME != 0 {
		ex.Btime = time.Unix(stx.Btime.Sec, int64(stx.Btime.Nsec)).UTC().Format(time.RFC3339)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		if target, err := os.Readlink(path); err == nil {
			ex.LinkTarget = target
		}
	}
	if info.Mode().IsRegular() {
		ex.Mime = detectMime(path)
	}
	return ex
}

// detectMime names a regular file's type from its extension, else from its
// first bytes (read as the user, like the stat itself).
func detectMime(path string) string {
	if t := mime.TypeByExtension(strings.ToLower(filepath.Ext(path))); t != "" {
		return strings.TrimSpace(strings.SplitN(t, ";", 2)[0])
	}
	f, fe := openRegular(path)
	if fe != nil {
		return ""
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	if n == 0 {
		return ""
	}
	return strings.SplitN(http.DetectContentType(head[:n]), ";", 2)[0]
}

// openRegular opens path for reading only when it is a regular file. O_NONBLOCK
// keeps a FIFO or a device from blocking the open past any deadline.
func openRegular(path string) (*os.File, *fsError) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if errors.Is(err, syscall.ELOOP) {
			return nil, &fsError{Code: "ERR", Message: "a symlink has no content of its own"}
		}
		return nil, mapOsErr(err)
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, mapOsErr(err)
	}
	if info.IsDir() {
		f.Close()
		return nil, &fsError{Code: "EISDIR", Message: "a folder has no content to read"}
	}
	if !info.Mode().IsRegular() {
		f.Close()
		return nil, &fsError{Code: "ERR", Message: "not a regular file"}
	}
	return f, nil
}

// ── on-demand details ────────────────────────────────────────────────────────

type detailsReq struct {
	syncMsg
	Kind string `json:"kind"`
}

type folderSizeResult struct {
	Files   int64 `json:"files"`
	Folders int64 `json:"folders"`
	Bytes   int64 `json:"bytes"`
	// Partial: the deadline hit or some entries could not be read; the counts are a floor.
	Partial bool `json:"partial"`
}

type checksumResult struct {
	Sha256 string `json:"sha256"`
}

type mediaResult struct {
	Width    int     `json:"width,omitempty"`
	Height   int     `json:"height,omitempty"`
	Duration float64 `json:"duration,omitempty"`
	Format   string  `json:"format,omitempty"`
	Video    string  `json:"video,omitempty"`
	Audio    string  `json:"audio,omitempty"`
	// Probed: ffprobe was available and read the file.
	Probed bool `json:"probed"`
}

func folderSize(ctx context.Context, root string) folderSizeResult {
	var r folderSizeResult
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			r.Partial = true
			return filepath.SkipAll
		}
		if err != nil {
			r.Partial = true
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if p == root {
			return nil
		}
		if d.IsDir() {
			r.Folders++
			return nil
		}
		// Symlinks count as entries, never followed.
		r.Files++
		if d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				r.Bytes += info.Size()
			}
		}
		return nil
	})
	return r
}

func checksum(ctx context.Context, path string) (*checksumResult, *fsError) {
	f, fe := openRegular(path)
	if fe != nil {
		if fe.Code == "EISDIR" {
			fe.Message = "a folder has no checksum"
		}
		return nil, fe
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, 1<<20)
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		if ctx.Err() != nil {
			return nil, &fsError{Code: "ETIMEDOUT", Message: "the file is too large to checksum in time"}
		}
		n, err := r.Read(buf)
		h.Write(buf[:n])
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, mapOsErr(err)
		}
	}
	return &checksumResult{Sha256: hex.EncodeToString(h.Sum(nil))}, nil
}

func imageSize(path string) (int, int, bool) {
	f, fe := openRegular(path)
	if fe != nil {
		return 0, 0, false
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return 0, 0, false
	}
	return cfg.Width, cfg.Height, true
}

type ffprobeOut struct {
	Format struct {
		FormatLongName string `json:"format_long_name"`
		Duration       string `json:"duration"`
	} `json:"format"`
	Streams []struct {
		CodecType string `json:"codec_type"`
		CodecName string `json:"codec_name"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
	} `json:"streams"`
}

// media reads an image's dimensions as the user, or probes audio and video
// with ffprobe (run with the user's credentials) when it is installed; without
// it the result just says it was not probed.
func media(ctx context.Context, path string, user userCtx) (*mediaResult, *fsError) {
	r := &mediaResult{}
	var ok bool
	read := func() error {
		r.Width, r.Height, ok = imageSize(path)
		return nil
	}
	var err error
	if user.uid == 0 {
		err = read()
	} else {
		err = runAsUser(user, read)
	}
	if err != nil {
		return nil, &fsError{Code: "ERR", Message: err.Error()}
	}
	if ok {
		return r, nil
	}
	r.Width, r.Height = 0, 0
	bin, lookErr := exec.LookPath("ffprobe")
	if lookErr != nil {
		return r, nil
	}
	cmd := exec.CommandContext(ctx, bin, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "--", path)
	if user.uid != 0 {
		groups := make([]uint32, 0, len(user.gids))
		for _, g := range user.gids {
			groups = append(groups, uint32(g))
		}
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(user.uid), Gid: uint32(user.gid), Groups: groups}}
	}
	out, err := cmd.Output()
	if err != nil {
		return r, nil
	}
	var probe ffprobeOut
	if json.Unmarshal(out, &probe) != nil {
		return r, nil
	}
	r.Probed = true
	r.Format = probe.Format.FormatLongName
	if d, err := strconv.ParseFloat(probe.Format.Duration, 64); err == nil {
		r.Duration = d
	}
	for _, s := range probe.Streams {
		switch s.CodecType {
		case "video":
			if r.Video == "" {
				r.Video = s.CodecName
				r.Width, r.Height = s.Width, s.Height
			}
		case "audio":
			if r.Audio == "" {
				r.Audio = s.CodecName
			}
		}
	}
	return r, nil
}

// detailsSlots bounds concurrent detail requests: each can read for up to the
// deadline, and they run off the subscription's goroutine so a slow one never
// queues the next.
var detailsSlots = make(chan struct{}, 2)

func handleDetails(nc *nats.Conn, msg *nats.Msg) {
	select {
	case detailsSlots <- struct{}{}:
	default:
		replyErr(nc, msg.Reply, &fsError{Code: "EBUSY", Message: "other details are being computed, try again in a moment"})
		return
	}
	go func() {
		defer func() { <-detailsSlots }()
		runDetails(nc, msg)
	}()
}

func runDetails(nc *nats.Conn, msg *nats.Msg) {
	var req detailsReq
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if fsErr := validateScoped(req.Path, req.AllowedRoot); fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
		return
	}
	user, err := resolveUserCtx(req.LinuxUsername)
	if err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), detailsDeadline)
	defer cancel()

	var result interface{}
	var fsErr *fsError
	run := func() error {
		switch req.Kind {
		case "folderSize":
			result = folderSize(ctx, req.Path)
		case "checksum":
			result, fsErr = checksum(ctx, req.Path)
		case "media":
			// ffprobe gets the user's identity through its own credentials.
			result, fsErr = media(ctx, req.Path, user)
		default:
			fsErr = &fsError{Code: "ERR", Message: "unknown detail: " + req.Kind}
		}
		return nil
	}
	if req.Kind == "media" {
		_ = run()
	} else if err := withUser(req.LinuxUsername, run); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
		return
	}
	replyOk(nc, msg.Reply, result)
}

// ── filesystem of a path ─────────────────────────────────────────────────────

var fsMagic = map[int64]string{
	0xEF53: "ext4", 0x58465342: "xfs", 0x9123683E: "btrfs", 0x4d44: "vfat",
	0x2011BAB0: "exfat", 0x5346544e: "ntfs", 0x65735546: "fuse", 0x01021994: "tmpfs",
	0x794c7630: "overlay", 0x2fc12fc1: "zfs", 0x6969: "nfs", 0xFF534D42: "cifs",
	0xF2F52010: "f2fs", 0x3153464a: "jfs",
}

func fsTypeName(magic int64) string {
	if name, ok := fsMagic[magic]; ok {
		return name
	}
	return ""
}

// mountOf returns the mount point and source holding path, from the longest
// matching mount point in a mountinfo listing.
func mountOf(mountinfo, path string) (mountPoint, source string) {
	best := -1
	for _, line := range strings.Split(mountinfo, "\n") {
		fields := strings.Fields(line)
		sep := -1
		for i, f := range fields {
			if f == "-" {
				sep = i
				break
			}
		}
		if len(fields) < 5 || sep < 0 || sep+2 >= len(fields) {
			continue
		}
		mp := unescapeMount(fields[4])
		if path != mp && !strings.HasPrefix(path, strings.TrimSuffix(mp, "/")+"/") {
			continue
		}
		if len(mp) > best {
			best = len(mp)
			mountPoint, source = mp, fields[sep+2]
		}
	}
	return mountPoint, source
}

// unescapeMount decodes the octal escapes mountinfo uses for spaces and tabs.
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
