package main

// Per-place trash (#200). A place with the trash on keeps deleted items in
// <place>/.hsi-trash, laid out like the freedesktop.org trash: files/<id> holds
// the item and info/<id>.trashinfo its original path, deletion date and who
// deleted it. The info file is written first, so an interrupted move leaves at
// worst an info file without an item, which listings skip and purges clean.
// Moving stays on one filesystem, so it is a rename: instant and atomic.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
	"golang.org/x/sys/unix"
)

const (
	trashDirName = ".hsi-trash"
	trashInfoExt = ".trashinfo"
	trashTimeFmt = "2006-01-02T15:04:05"
)

type trashEntry struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	OriginalPath string `json:"originalPath"`
	DeletedAt    string `json:"deletedAt"`
	DeletedBy    string `json:"deletedBy,omitempty"`
	Type         string `json:"type"`
	Size         *int64 `json:"size"`
}

func trashDirs(placeRoot string) (root, files, info string) {
	root = filepath.Join(placeRoot, trashDirName)
	return root, filepath.Join(root, "files"), filepath.Join(root, "info")
}

// validTrashID refuses anything that could leave the trash folders.
func validTrashID(id string) bool {
	return id != "" && id != "." && id != ".." && !strings.ContainsAny(id, "/\x00") && len(id) <= 255
}

// ensureTrash creates the trash folders, group-writable and setgid like the
// place root, so every writer of the place can move items in and out.
func ensureTrash(placeRoot string) (files, info string, fe *fsError) {
	root, files, info := trashDirs(placeRoot)
	for _, d := range []string{root, files, info} {
		if err := os.Mkdir(d, 0o775|os.ModeSetgid); err != nil && !errors.Is(err, os.ErrExist) {
			return "", "", mapOsErr(err)
		}
		if fi, err := os.Lstat(d); err != nil || !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
			return "", "", &fsError{Code: "ERR", Message: "the trash folder is not a folder"}
		}
		// Mkdir's mode is masked by the umask; set it as asked (owner only, best effort).
		_ = os.Chmod(d, 0o775|os.ModeSetgid)
	}
	return files, info, nil
}

// trashInside reports whether path is the trash itself or inside it.
func trashInside(placeRoot, path string) bool {
	root, _, _ := trashDirs(placeRoot)
	return path == root || strings.HasPrefix(path, root+"/")
}

func encodeTrashInfo(original string, at time.Time, by string) string {
	u := url.URL{Path: original}
	var b strings.Builder
	b.WriteString("[Trash Info]\n")
	b.WriteString("Path=" + u.EscapedPath() + "\n")
	b.WriteString("DeletionDate=" + at.Format(trashTimeFmt) + "\n")
	if by != "" {
		b.WriteString("X-HSI-DeletedBy=" + url.QueryEscape(by) + "\n")
	}
	return b.String()
}

type trashInfo struct {
	Path      string
	DeletedAt time.Time
	DeletedBy string
}

func parseTrashInfo(data string) (trashInfo, error) {
	var ti trashInfo
	sc := bufio.NewScanner(strings.NewReader(data))
	header := false
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "[Trash Info]" {
			header = true
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || !header {
			continue
		}
		switch key {
		case "Path":
			p, err := url.PathUnescape(value)
			if err != nil {
				return ti, err
			}
			ti.Path = p
		case "DeletionDate":
			t, err := time.ParseInLocation(trashTimeFmt, value, time.Local)
			if err != nil {
				return ti, err
			}
			ti.DeletedAt = t
		case "X-HSI-DeletedBy":
			if by, err := url.QueryUnescape(value); err == nil {
				ti.DeletedBy = by
			}
		}
	}
	if !header || ti.Path == "" || ti.DeletedAt.IsZero() {
		return ti, errors.New("not a trash info file")
	}
	return ti, nil
}

// doTrash moves path into its place's trash and returns the new entry.
func doTrash(placeRoot, path, deletedBy string, now time.Time) (*trashEntry, *fsError) {
	placeRoot = filepath.Clean(placeRoot)
	path = filepath.Clean(path)
	if path == placeRoot || !strings.HasPrefix(path, placeRoot+"/") {
		return nil, &fsError{Code: "EACCES", Message: "only items inside a place go to its trash"}
	}
	if trashInside(placeRoot, path) {
		return nil, &fsError{Code: "ERR", Message: "items already in the trash are deleted permanently"}
	}
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, mapOsErr(err)
	}
	files, info, fe := ensureTrash(placeRoot)
	if fe != nil {
		return nil, fe
	}
	base := filepath.Base(path)
	content := encodeTrashInfo(path, now, deletedBy)
	// Reserve a free id by creating its info file exclusively.
	var id string
	for n := 1; n < 10000; n++ {
		candidate := base
		if n > 1 {
			candidate = base + "." + strconv.Itoa(n)
		}
		f, err := os.OpenFile(filepath.Join(info, candidate+trashInfoExt), os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o664)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return nil, mapOsErr(err)
		}
		_, werr := f.WriteString(content)
		cerr := f.Close()
		if werr != nil || cerr != nil {
			_ = os.Remove(filepath.Join(info, candidate+trashInfoExt))
			return nil, &fsError{Code: "ERR", Message: "could not record the trash entry"}
		}
		if _, err := os.Lstat(filepath.Join(files, candidate)); err == nil {
			// A leftover item without its info: keep it, try the next id.
			_ = os.Remove(filepath.Join(info, candidate+trashInfoExt))
			continue
		}
		id = candidate
		break
	}
	if id == "" {
		return nil, &fsError{Code: "ERR", Message: "too many items with this name in the trash"}
	}
	if err := os.Rename(path, filepath.Join(files, id)); err != nil {
		_ = os.Remove(filepath.Join(info, id+trashInfoExt))
		if errors.Is(err, syscall.EXDEV) {
			return nil, &fsError{Code: "EXDEV", Message: "this item is on another volume than its place: delete it permanently instead"}
		}
		return nil, mapOsErr(err)
	}
	return entryFor(files, id, trashInfo{Path: path, DeletedAt: now, DeletedBy: deletedBy}, fi), nil
}

func entryFor(files, id string, ti trashInfo, fi os.FileInfo) *trashEntry {
	e := &trashEntry{
		ID: id, Name: filepath.Base(ti.Path), OriginalPath: ti.Path,
		DeletedAt: ti.DeletedAt.UTC().Format(time.RFC3339), DeletedBy: ti.DeletedBy, Type: "file",
	}
	if fi == nil {
		var err error
		if fi, err = os.Lstat(filepath.Join(files, id)); err != nil {
			return e
		}
	}
	if fi.IsDir() {
		e.Type = "dir"
	} else {
		sz := fi.Size()
		e.Size = &sz
	}
	return e
}

func readTrashInfo(info, id string) (trashInfo, *fsError) {
	data, err := os.ReadFile(filepath.Join(info, id+trashInfoExt))
	if err != nil {
		return trashInfo{}, mapOsErr(err)
	}
	ti, err := parseTrashInfo(string(data))
	if err != nil {
		return trashInfo{}, &fsError{Code: "ERR", Message: err.Error()}
	}
	return ti, nil
}

// doTrashList lists the trash of a place, newest first. A missing trash is empty.
func doTrashList(placeRoot string) ([]trashEntry, *fsError) {
	_, files, info := trashDirs(filepath.Clean(placeRoot))
	names, err := os.ReadDir(info)
	if errors.Is(err, os.ErrNotExist) {
		return []trashEntry{}, nil
	}
	if err != nil {
		return nil, mapOsErr(err)
	}
	out := []trashEntry{}
	for _, d := range names {
		id, ok := strings.CutSuffix(d.Name(), trashInfoExt)
		if !ok || !validTrashID(id) {
			continue
		}
		ti, fe := readTrashInfo(info, id)
		if fe != nil {
			continue
		}
		fi, err := os.Lstat(filepath.Join(files, id))
		if err != nil {
			continue // interrupted move: no item behind this info
		}
		out = append(out, *entryFor(files, id, ti, fi))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DeletedAt > out[j].DeletedAt })
	return out, nil
}

// doTrashRestore puts an item back where it was, or at target when given.
// It never overwrites: a taken destination is EEXIST and the item stays.
func doTrashRestore(placeRoot, id, target string) (string, *fsError) {
	placeRoot = filepath.Clean(placeRoot)
	if !validTrashID(id) {
		return "", &fsError{Code: "ERR", Message: "invalid trash item"}
	}
	_, files, info := trashDirs(placeRoot)
	ti, fe := readTrashInfo(info, id)
	if fe != nil {
		return "", fe
	}
	dst := filepath.Clean(ti.Path)
	if target != "" {
		dst = filepath.Clean(target)
	}
	if dst == placeRoot || !strings.HasPrefix(dst, placeRoot+"/") || trashInside(placeRoot, dst) {
		return "", &fsError{Code: "EACCES", Message: "an item is restored inside its place"}
	}
	// The info file is writable by the place's writers: never trust its path
	// past a symlink.
	if err := rejectSymlinkComponents(placeRoot, dst); err != nil {
		return "", &fsError{Code: "EACCES", Message: "the destination goes through a symlink"}
	}
	if _, err := os.Lstat(dst); err == nil {
		return "", &fsError{Code: "EEXIST", Message: "something already exists at " + dst}
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o775|os.ModeSetgid); err != nil {
		return "", mapOsErr(err)
	}
	if err := os.Rename(filepath.Join(files, id), dst); err != nil {
		return "", mapOsErr(err)
	}
	_ = os.Remove(filepath.Join(info, id+trashInfoExt))
	return dst, nil
}

// doTrashDelete removes items for good; no ids empties the trash.
func doTrashDelete(placeRoot string, ids []string) *fsError {
	files, info, ok, fe := trashFds(placeRoot)
	if fe != nil || !ok {
		return fe
	}
	defer unix.Close(files)
	defer unix.Close(info)
	if len(ids) == 0 {
		names, err := dirNames(info)
		if err != nil {
			return mapOsErr(err)
		}
		for _, n := range names {
			if id, ok := strings.CutSuffix(n, trashInfoExt); ok {
				ids = append(ids, id)
			}
		}
		// Items left without an info file go too.
		if items, err := dirNames(files); err == nil {
			ids = append(ids, items...)
		}
	}
	for _, id := range ids {
		if !validTrashID(id) {
			return &fsError{Code: "ERR", Message: "invalid trash item"}
		}
		if err := removeAllAt(files, id); err != nil {
			return mapOsErr(err)
		}
		if err := unix.Unlinkat(info, id+trashInfoExt, 0); err != nil && !errors.Is(err, unix.ENOENT) {
			return mapOsErr(err)
		}
	}
	return nil
}

// doTrashPurge removes items deleted before cutoff, and info files whose item
// is gone. It returns how many items it removed.
func doTrashPurge(placeRoot string, cutoff time.Time) (int, *fsError) {
	files, info, ok, fe := trashFds(placeRoot)
	if fe != nil || !ok {
		return 0, fe
	}
	defer unix.Close(files)
	defer unix.Close(info)
	names, err := dirNames(info)
	if err != nil {
		return 0, mapOsErr(err)
	}
	removed := 0
	for _, n := range names {
		id, ok := strings.CutSuffix(n, trashInfoExt)
		if !ok || !validTrashID(id) {
			continue
		}
		ti, fe := readTrashInfoAt(info, id)
		var st unix.Stat_t
		statErr := unix.Fstatat(files, id, &st, unix.AT_SYMLINK_NOFOLLOW)
		orphan := errors.Is(statErr, unix.ENOENT)
		if fe == nil && !orphan && !ti.DeletedAt.Before(cutoff) {
			continue
		}
		if fe != nil && !orphan {
			continue // unreadable info for a present item: leave it for a person to decide
		}
		if err := removeAllAt(files, id); err != nil {
			return removed, mapOsErr(err)
		}
		if err := unix.Unlinkat(info, id+trashInfoExt, 0); err != nil && !errors.Is(err, unix.ENOENT) {
			return removed, mapOsErr(err)
		}
		if !orphan {
			removed++
		}
	}
	return removed, nil
}

// ── NATS handler ─────────────────────────────────────────────────────────────

type trashReq struct {
	LinuxUsername string   `json:"linuxUsername"`
	Op            string   `json:"op"`
	PlaceRoot     string   `json:"placeRoot"`
	Path          string   `json:"path"`
	DeletedBy     string   `json:"deletedBy"`
	IDs           []string `json:"ids"`
	Target        string   `json:"target"`
	OlderThanDays int      `json:"olderThanDays"`
}

// trashSlots runs trash requests off the subscription goroutine, a few at a
// time: emptying a large trash must not hold up a move into another one.
var trashSlots = make(chan struct{}, 4)

func handleTrash(nc *nats.Conn, msg *nats.Msg) {
	trashSlots <- struct{}{}
	go func() {
		defer func() { <-trashSlots }()
		runTrash(nc, msg)
	}()
}

func runTrash(nc *nats.Conn, msg *nats.Msg) {
	var req trashReq
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if err := validatePath(req.PlaceRoot); err != nil || filepath.Clean(req.PlaceRoot) == "/" {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid place"})
		return
	}
	if fe := rejectTrashSymlink(req.PlaceRoot); fe != nil {
		replyErr(nc, msg.Reply, fe)
		return
	}
	var result interface{}
	var fsErr *fsError
	run := func() error {
		switch req.Op {
		case "trash":
			if fsErr = validateScoped(req.Path, req.PlaceRoot); fsErr == nil {
				result, fsErr = doTrash(req.PlaceRoot, req.Path, req.DeletedBy, time.Now())
			}
		case "list":
			result, fsErr = doTrashList(req.PlaceRoot)
		case "restore":
			if len(req.IDs) != 1 {
				fsErr = &fsError{Code: "ERR", Message: "restore one item at a time"}
				break
			}
			var dst string
			if dst, fsErr = doTrashRestore(req.PlaceRoot, req.IDs[0], req.Target); fsErr == nil {
				result = map[string]string{"path": dst}
			}
		case "delete":
			if len(req.IDs) == 0 {
				fsErr = &fsError{Code: "ERR", Message: "no items given"}
				break
			}
			fsErr = doTrashDelete(req.PlaceRoot, req.IDs)
			result = map[string]bool{"ok": true}
		case "empty":
			fsErr = doTrashDelete(req.PlaceRoot, nil)
			result = map[string]bool{"ok": true}
		case "purge":
			if req.OlderThanDays < 1 {
				fsErr = &fsError{Code: "ERR", Message: "a purge needs a number of days"}
				break
			}
			var n int
			n, fsErr = doTrashPurge(req.PlaceRoot, time.Now().AddDate(0, 0, -req.OlderThanDays))
			result = map[string]int{"removed": n}
		default:
			fsErr = &fsError{Code: "ERR", Message: fmt.Sprintf("unknown trash operation %q", req.Op)}
		}
		return nil
	}
	if err := withUser(req.LinuxUsername, run); err != nil {
		replyErr(nc, msg.Reply, toFsErr(err))
		return
	}
	if fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
		return
	}
	replyOk(nc, msg.Reply, result)
}

// rejectTrashSymlink refuses a trash folder that is a symlink, which would
// send moves and removals somewhere else.
func rejectTrashSymlink(placeRoot string) *fsError {
	root, files, info := trashDirs(filepath.Clean(placeRoot))
	for _, d := range []string{root, files, info} {
		if fi, err := os.Lstat(d); err == nil && fi.Mode()&os.ModeSymlink != 0 {
			return &fsError{Code: "ERR", Message: "the trash folder is a symlink"}
		}
	}
	return nil
}

// ── symlink-proof removal ────────────────────────────────────────────────────
// Emptying and purging run as root, inside folders place writers can change.
// The trash folders are opened without following any symlink, and every
// removal is relative to them, never following one either: swapping a folder
// for a link between a check and a removal can only make the removal fail.

func openTrashDir(path string) (int, error) {
	fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{
		Flags:   unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_NO_SYMLINKS,
	})
	if errors.Is(err, unix.ENOSYS) {
		if real, rerr := filepath.EvalSymlinks(path); rerr != nil || real != path {
			return -1, &os.PathError{Op: "open", Path: path, Err: unix.ELOOP}
		}
		fd, err = unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	}
	if err != nil {
		return -1, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return fd, nil
}

// removeAllAt removes name under dirfd and everything inside it.
func removeAllAt(dirfd int, name string) error {
	err := unix.Unlinkat(dirfd, name, 0)
	if err == nil || errors.Is(err, unix.ENOENT) {
		return nil
	}
	if !errors.Is(err, unix.EISDIR) && !errors.Is(err, unix.EPERM) {
		return err
	}
	fd, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	dir := os.NewFile(uintptr(fd), name)
	names, rerr := dir.Readdirnames(-1)
	if rerr == nil {
		for _, n := range names {
			if err := removeAllAt(fd, n); err != nil {
				dir.Close()
				return err
			}
		}
	}
	dir.Close()
	if rerr != nil {
		return rerr
	}
	return unix.Unlinkat(dirfd, name, unix.AT_REMOVEDIR)
}

// readTrashInfoAt reads an info file relative to the info folder, refusing a symlink.
func readTrashInfoAt(infoFd int, id string) (trashInfo, *fsError) {
	fd, err := unix.Openat(infoFd, id+trashInfoExt, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return trashInfo{}, mapOsErr(err)
	}
	f := os.NewFile(uintptr(fd), id+trashInfoExt)
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() || fi.Size() > 64*1024 {
		return trashInfo{}, &fsError{Code: "ERR", Message: "not a trash info file"}
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return trashInfo{}, mapOsErr(err)
	}
	ti, perr := parseTrashInfo(string(data))
	if perr != nil {
		return trashInfo{}, &fsError{Code: "ERR", Message: perr.Error()}
	}
	return ti, nil
}

// trashFds opens the files and info folders of a place's trash; ok is false
// when there is no trash yet.
func trashFds(placeRoot string) (files, info int, ok bool, fe *fsError) {
	_, filesPath, infoPath := trashDirs(filepath.Clean(placeRoot))
	ffd, err := openTrashDir(filesPath)
	if errors.Is(err, os.ErrNotExist) {
		return -1, -1, false, nil
	}
	if err != nil {
		return -1, -1, false, mapOsErr(err)
	}
	ifd, err := openTrashDir(infoPath)
	if err != nil {
		unix.Close(ffd)
		if errors.Is(err, os.ErrNotExist) {
			return -1, -1, false, nil
		}
		return -1, -1, false, mapOsErr(err)
	}
	return ffd, ifd, true, nil
}

func dirNames(fd int) ([]string, error) {
	dup, err := unix.Dup(fd)
	if err != nil {
		return nil, err
	}
	d := os.NewFile(uintptr(dup), "trash")
	defer d.Close()
	return d.Readdirnames(-1)
}
