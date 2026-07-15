package main

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ── Path validation ───────────────────────────────────────────────────────────

func validatePath(p string) error {
	if strings.ContainsRune(p, 0) {
		return fmt.Errorf("invalid path: null byte")
	}
	if !filepath.IsAbs(filepath.Clean(p)) {
		return fmt.Errorf("invalid path: must be absolute")
	}
	return nil
}

// resolveExisting walks up from p until it finds an existing ancestor,
// resolves symlinks on that ancestor, then re-joins the (possibly
// non-existing) tail. This lets us compute the real target of operations
// whose final path component doesn't exist yet (mkdir, copy/move/rename
// destinations).
func resolveExisting(p string) (string, error) {
	clean := filepath.Clean(p)
	if real, err := filepath.EvalSymlinks(clean); err == nil {
		return real, nil
	}
	dir := filepath.Dir(clean)
	if dir == clean {
		return "", fmt.Errorf("invalid path: %s", p)
	}
	realDir, err := resolveExisting(dir)
	if err != nil {
		return "", err
	}
	return filepath.Join(realDir, filepath.Base(clean)), nil
}

// containedIn resolves p (following symlinks on its existing ancestors) and
// verifies the result lies within root (also symlink-resolved). An empty
// root disables the check — used for admin/root-level operations that are
// intentionally unrestricted to the whole filesystem.
//
// This closes the common case of a user planting a symlink inside their
// allowed directory to read/write outside it, or using ".." in a supplied
// name to escape it. It does not eliminate a TOCTOU race where the symlink
// is swapped between this check and the actual operation; closing that
// fully would require an openat-based path walk.
func containedIn(p, root string) error {
	if root == "" {
		return nil
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return fmt.Errorf("invalid allowed root: %w", err)
	}
	real, err := resolveExisting(p)
	if err != nil {
		return err
	}
	if real != realRoot && !strings.HasPrefix(real, realRoot+string(filepath.Separator)) {
		return fmt.Errorf("path escapes allowed root")
	}
	return nil
}

// validateScoped runs validatePath plus a containedIn check against root.
func validateScoped(p, root string) *fsError {
	if err := validatePath(p); err != nil {
		return &fsError{Code: "ERR", Message: err.Error()}
	}
	if err := containedIn(p, root); err != nil {
		return &fsError{Code: "EACCES", Message: err.Error()}
	}
	return nil
}

// validatePathsScoped applies validateScoped to every path against the same root.
func validatePathsScoped(root string, paths ...string) *fsError {
	for _, p := range paths {
		if err := validateScoped(p, root); err != nil {
			return err
		}
	}
	return nil
}

// ── Error mapping ─────────────────────────────────────────────────────────────

type fsError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *fsError) Error() string { return e.Message }

func mapOsErr(err error) *fsError {
	var pathErr *fs.PathError
	var linkErr *os.LinkError
	var errno syscall.Errno
	if errors.As(err, &pathErr) {
		if e, ok := pathErr.Err.(syscall.Errno); ok {
			errno = e
		}
	} else if errors.As(err, &linkErr) {
		if e, ok := linkErr.Err.(syscall.Errno); ok {
			errno = e
		}
	}
	switch errno {
	case syscall.EACCES, syscall.EPERM:
		return &fsError{Code: "EACCES", Message: "permission denied"}
	case syscall.ENOENT:
		return &fsError{Code: "ENOENT", Message: "no such file or directory"}
	case syscall.EEXIST, syscall.ENOTEMPTY:
		return &fsError{Code: "EEXIST", Message: "destination already exists"}
	}
	if err != nil {
		return &fsError{Code: "ERR", Message: err.Error()}
	}
	return nil
}

// ── list ──────────────────────────────────────────────────────────────────────

type listEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Type  string `json:"type"`
	Size  *int64 `json:"size"`
	Mtime string `json:"mtime"`
}

func doList(dir string) ([]listEntry, *fsError) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, mapOsErr(err)
	}
	result := make([]listEntry, 0, len(entries))
	for _, e := range entries {
		full := filepath.Join(dir, e.Name())
		info, err := os.Stat(full)
		if err != nil {
			continue
		}
		le := listEntry{
			Name:  e.Name(),
			Path:  full,
			Mtime: info.ModTime().UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		}
		if info.IsDir() {
			le.Type = "dir"
		} else {
			le.Type = "file"
			sz := info.Size()
			le.Size = &sz
		}
		result = append(result, le)
	}
	return result, nil
}

// ── stat ──────────────────────────────────────────────────────────────────────

type statResult struct {
	Mode  string `json:"mode"`
	Owner string `json:"owner"`
	Group string `json:"group"`
	Uid   int    `json:"uid"`
	Gid   int    `json:"gid"`
	Type  string `json:"type"`
	Size  *int64 `json:"size"`
	Mtime string `json:"mtime"`
	Ctime string `json:"ctime"`
}

func doStat(path string) (*statResult, *fsError) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, mapOsErr(err)
	}
	sys := info.Sys().(*syscall.Stat_t)
	uid := int(sys.Uid)
	gid := int(sys.Gid)
	mode := fmt.Sprintf("%03o", info.Mode().Perm())

	ownerName := strconv.Itoa(uid)
	if u, err := user.LookupId(strconv.Itoa(uid)); err == nil {
		ownerName = u.Username
	}
	groupName := strconv.Itoa(gid)
	if g, err := user.LookupGroupId(strconv.Itoa(gid)); err == nil {
		groupName = g.Name
	}

	typ := "file"
	if info.IsDir() {
		typ = "dir"
	}
	var size *int64
	if !info.IsDir() {
		sz := info.Size()
		size = &sz
	}
	mtime := time.Unix(sys.Mtim.Sec, sys.Mtim.Nsec).UTC().Format(time.RFC3339)
	ctime := time.Unix(sys.Ctim.Sec, sys.Ctim.Nsec).UTC().Format(time.RFC3339)
	return &statResult{Mode: mode, Owner: ownerName, Group: groupName, Uid: uid, Gid: gid, Type: typ, Size: size, Mtime: mtime, Ctime: ctime}, nil
}

// ── disk usage ───────────────────────────────────────────────────────────────

type diskUsageResult struct {
	Total int64 `json:"total"`
	Free  int64 `json:"free"`
}

func doDiskUsage(path string) (*diskUsageResult, *fsError) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return nil, mapOsErr(err)
	}
	bsize := int64(st.Bsize)
	return &diskUsageResult{
		Total: int64(st.Blocks) * bsize,
		Free:  int64(st.Bavail) * bsize, // Bavail = available to non-root
	}, nil
}

// ── read ──────────────────────────────────────────────────────────────────────

const maxReadBytes = 64 * 1024 * 1024 // 64 MB

func doRead(path string) ([]byte, *fsError) {
	f, err := os.Open(path)
	if err != nil {
		return nil, mapOsErr(err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxReadBytes))
	if err != nil {
		return nil, mapOsErr(err)
	}
	return data, nil
}

const maxReadChunkBytes = 4 * 1024 * 1024 // 4 MB hard cap, independent of caller-requested length

func doReadChunk(path string, offset int64, length int) ([]byte, *fsError) {
	if length <= 0 || length > maxReadChunkBytes {
		length = maxReadChunkBytes
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, mapOsErr(err)
	}
	defer f.Close()
	buf := make([]byte, length)
	n, err := f.ReadAt(buf, offset)
	if err != nil && err != io.EOF {
		return nil, mapOsErr(err)
	}
	return buf[:n], nil
}

// ── mkdir ─────────────────────────────────────────────────────────────────────

type mkdirResult struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

func doMkdir(parent, name string) (*mkdirResult, *fsError) {
	if name == "" {
		name = "New Folder"
	}
	target := filepath.Join(parent, name)
	for n := 1; n <= 1000; n++ {
		if _, err := os.Lstat(target); os.IsNotExist(err) {
			break
		}
		target = filepath.Join(parent, fmt.Sprintf("%s (%d)", name, n))
	}
	if err := os.MkdirAll(target, 0775); err != nil {
		return nil, mapOsErr(err)
	}
	return &mkdirResult{Path: target, Name: filepath.Base(target)}, nil
}

// ── copy ──────────────────────────────────────────────────────────────────────

type copyResult struct {
	Ok  bool   `json:"ok"`
	Dst string `json:"dst"`
}

func uniqueDst(src, dstDir string) string {
	base := filepath.Base(src)
	ext := filepath.Ext(base)
	name := strings.TrimSuffix(base, ext)
	candidate := filepath.Join(dstDir, base)
	for n := 1; n <= 1000; n++ {
		if _, err := os.Lstat(candidate); os.IsNotExist(err) {
			return candidate
		}
		candidate = filepath.Join(dstDir, fmt.Sprintf("%s (%d)%s", name, n, ext))
	}
	return candidate
}

func copyAll(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return copyDir(src, dst, info)
	}
	return copyFile(src, dst, info)
}

func copyFile(src, dst string, info fs.FileInfo) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func copyDir(src, dst string, info fs.FileInfo) error {
	if err := os.MkdirAll(dst, info.Mode()); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())
		ei, err := e.Info()
		if err != nil {
			return err
		}
		if e.IsDir() {
			if err := copyDir(s, d, ei); err != nil {
				return err
			}
		} else {
			if err := copyFile(s, d, ei); err != nil {
				return err
			}
		}
	}
	return nil
}

func doCopy(src, dstDir string) (*copyResult, *fsError) {
	dst := uniqueDst(src, dstDir)
	if err := copyAll(src, dst); err != nil {
		return nil, mapOsErr(err)
	}
	return &copyResult{Ok: true, Dst: dst}, nil
}

// ── move ──────────────────────────────────────────────────────────────────────

type moveResult struct {
	Ok  bool   `json:"ok"`
	Dst string `json:"dst"`
}

func doMove(src, dstDir string) (*moveResult, *fsError) {
	dst := filepath.Join(dstDir, filepath.Base(src))
	if _, err := os.Lstat(dst); err == nil {
		return nil, &fsError{Code: "EEXIST", Message: "destination already exists"}
	}
	err := os.Rename(src, dst)
	if err != nil {
		var linkErr *os.LinkError
		if errors.As(err, &linkErr) {
			if errno, ok := linkErr.Err.(syscall.Errno); ok && errno == syscall.EXDEV {
				if err2 := copyAll(src, dst); err2 != nil {
					return nil, mapOsErr(err2)
				}
				if err2 := os.RemoveAll(src); err2 != nil {
					return nil, mapOsErr(err2)
				}
				return &moveResult{Ok: true, Dst: dst}, nil
			}
		}
		return nil, mapOsErr(err)
	}
	return &moveResult{Ok: true, Dst: dst}, nil
}

// ── rename ────────────────────────────────────────────────────────────────────

type renameResult struct {
	Ok  bool   `json:"ok"`
	Dst string `json:"dst"`
}

func doRename(path, newName string) (*renameResult, *fsError) {
	dst := filepath.Join(filepath.Dir(path), newName)
	if _, err := os.Lstat(dst); err == nil {
		return nil, &fsError{Code: "EEXIST", Message: "destination already exists"}
	}
	if err := os.Rename(path, dst); err != nil {
		return nil, mapOsErr(err)
	}
	return &renameResult{Ok: true, Dst: dst}, nil
}

// ── delete ────────────────────────────────────────────────────────────────────

func doDelete(path string) *fsError {
	if err := os.RemoveAll(path); err != nil {
		return mapOsErr(err)
	}
	return nil
}

// ── assemble ──────────────────────────────────────────────────────────────────

func doAssemble(destFile string, chunks []string) *fsError {
	// 0664 so uploads land group-writable (with umask 0002); combined with the
	// setgid share dir this lets any write-user overwrite the file later.
	out, err := os.OpenFile(destFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0664)
	if err != nil {
		return mapOsErr(err)
	}
	defer out.Close()
	for _, chunk := range chunks {
		f, err := os.Open(chunk)
		if err != nil {
			return mapOsErr(err)
		}
		_, cpErr := io.Copy(out, f)
		f.Close()
		if cpErr != nil {
			return &fsError{Code: "ERR", Message: cpErr.Error()}
		}
	}
	return nil
}

// ── chmod ─────────────────────────────────────────────────────────────────────

func doChmod(path, modeStr string) *fsError {
	mode, err := strconv.ParseUint(modeStr, 8, 32)
	if err != nil {
		return &fsError{Code: "ERR", Message: fmt.Sprintf("invalid mode %q", modeStr)}
	}
	if err := os.Chmod(path, fs.FileMode(mode)); err != nil {
		return mapOsErr(err)
	}
	return nil
}

// ── chown ─────────────────────────────────────────────────────────────────────

func doChown(path, ownerStr, groupStr string) *fsError {
	uid := -1
	if n, err := strconv.Atoi(ownerStr); err == nil {
		uid = n
	} else if u, err := user.Lookup(ownerStr); err == nil {
		if n, err := strconv.Atoi(u.Uid); err == nil {
			uid = n
		}
	} else {
		return &fsError{Code: "ERR", Message: fmt.Sprintf("unknown user %q", ownerStr)}
	}

	gid := -1
	if n, err := strconv.Atoi(groupStr); err == nil {
		gid = n
	} else if g, err := user.LookupGroup(groupStr); err == nil {
		if n, err := strconv.Atoi(g.Gid); err == nil {
			gid = n
		}
	} else {
		return &fsError{Code: "ERR", Message: fmt.Sprintf("unknown group %q", groupStr)}
	}

	if err := os.Lchown(path, uid, gid); err != nil {
		return mapOsErr(err)
	}
	return nil
}

// ── zip ───────────────────────────────────────────────────────────────────────

func doZip(paths []string, destDir, name string) *fsError {
	// Reject any name that tries to escape destDir via separators or dot-segments.
	clean := filepath.Base(filepath.Clean(name))
	if clean == "." || clean == ".." || strings.ContainsAny(clean, "/\\\x00") {
		return &fsError{Code: "ERR", Message: "invalid archive name"}
	}
	name = clean

	if err := os.MkdirAll(destDir, 0755); err != nil {
		return mapOsErr(err)
	}
	zipPath := filepath.Join(destDir, name)
	f, err := os.Create(zipPath)
	if err != nil {
		return mapOsErr(err)
	}
	defer f.Close()

	zw := zip.NewWriter(f)
	defer zw.Close()

	for _, src := range paths {
		info, err := os.Lstat(src)
		if err != nil {
			return mapOsErr(err)
		}
		parentDir := filepath.Dir(src)
		if info.IsDir() {
			if walkErr := filepath.Walk(src, func(walkPath string, fi fs.FileInfo, err error) error {
				if err != nil || fi.IsDir() {
					return err
				}
				rel, err := filepath.Rel(parentDir, walkPath)
				if err != nil {
					return err
				}
				w, err := zw.Create(rel)
				if err != nil {
					return err
				}
				in, err := os.Open(walkPath)
				if err != nil {
					return err
				}
				defer in.Close()
				_, err = io.Copy(w, in)
				return err
			}); walkErr != nil {
				return mapOsErr(walkErr)
			}
		} else {
			w, err := zw.Create(filepath.Base(src))
			if err != nil {
				return mapOsErr(err)
			}
			in, err := os.Open(src)
			if err != nil {
				return mapOsErr(err)
			}
			if _, err := io.Copy(w, in); err != nil {
				in.Close()
				return mapOsErr(err)
			}
			in.Close()
		}
	}
	return nil
}

// ── zip to temp (public share "download all") ──────────────────────────────────
//
// Builds a zip of a directory into the worker's (PrivateTmp) temp dir, streamed
// out afterwards by the backend via read-chunk, then removed via rm-temp. A hard
// disk guard runs both before (pre-flight) and during writing so a large folder
// can never fill the limited temp filesystem.

const (
	shareZipReserve  = 512 * 1024 * 1024       // always keep this much free on the temp fs
	shareZipMaxInput = 50 * 1024 * 1024 * 1024 // refuse folders whose contents exceed this
	shareZipTempPre  = "hsi-share-"            // temp file name prefix (see isShareTempPath)
)

var (
	errZipTooBig  = errors.New("folder too large")
	errZipNoSpace = errors.New("insufficient temp space")
)

func availBytes(path string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil // Bavail = available to non-root
}

// guardedWriter aborts once free space on its dir drops below reserve.
type guardedWriter struct {
	w          io.Writer
	dir        string
	reserve    int64
	checkEvery int64
	sinceCheck int64
	spaceErr   error
}

func (g *guardedWriter) Write(p []byte) (int, error) {
	if g.spaceErr != nil {
		return 0, g.spaceErr
	}
	g.sinceCheck += int64(len(p))
	if g.sinceCheck >= g.checkEvery {
		g.sinceCheck = 0
		if avail, err := availBytes(g.dir); err == nil && avail < g.reserve {
			g.spaceErr = errZipNoSpace
			return 0, g.spaceErr
		}
	}
	return g.w.Write(p)
}

// doZipToTemp must be called inside withUser so reads honour the caller's
// permissions and the temp file is owned by that user (read back the same way).
func doZipToTemp(srcPath string) (string, int64, *fsError) {
	info, err := os.Lstat(srcPath)
	if err != nil {
		return "", 0, mapOsErr(err)
	}
	if !info.IsDir() {
		return "", 0, &fsError{Code: "ERR", Message: "not a directory"}
	}
	tmpDir := os.TempDir()

	// Pre-flight early-reject: the uncompressed total is a rough size estimate
	// (not a strict upper bound — zip adds per-entry header overhead). The real
	// guarantee against filling the disk is the guardedWriter below, which
	// re-checks actual free space as it writes.
	var total int64
	if walkErr := filepath.Walk(srcPath, func(_ string, fi fs.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if fi.Mode().IsRegular() {
			total += fi.Size()
			if total > shareZipMaxInput {
				return errZipTooBig
			}
		}
		return nil
	}); walkErr != nil {
		if errors.Is(walkErr, errZipTooBig) {
			return "", 0, &fsError{Code: "TOOBIG", Message: "folder is too large to zip"}
		}
		return "", 0, mapOsErr(walkErr)
	}
	avail, err := availBytes(tmpDir)
	if err != nil {
		return "", 0, mapOsErr(err)
	}
	if avail-total < shareZipReserve {
		return "", 0, &fsError{Code: "NOSPC", Message: "not enough temporary disk space to build the archive"}
	}

	f, err := os.CreateTemp(tmpDir, shareZipTempPre+"*.zip")
	if err != nil {
		return "", 0, mapOsErr(err)
	}
	tmpPath := f.Name()
	gw := &guardedWriter{w: f, dir: tmpDir, reserve: shareZipReserve, checkEvery: 8 * 1024 * 1024}
	zw := zip.NewWriter(gw)

	fail := func(fe *fsError) (string, int64, *fsError) {
		zw.Close()
		f.Close()
		os.Remove(tmpPath)
		return "", 0, fe
	}

	parentDir := filepath.Dir(srcPath)
	if walkErr := filepath.Walk(srcPath, func(walkPath string, fi fs.FileInfo, err error) error {
		if err != nil || fi.IsDir() {
			return err
		}
		if !fi.Mode().IsRegular() {
			return nil // skip symlinks/devices — never follow them into the archive
		}
		rel, err := filepath.Rel(parentDir, walkPath)
		if err != nil {
			return err
		}
		w, err := zw.Create(rel)
		if err != nil {
			return err
		}
		in, err := os.Open(walkPath)
		if err != nil {
			return err
		}
		defer in.Close()
		_, err = io.Copy(w, in)
		return err
	}); walkErr != nil {
		if gw.spaceErr != nil {
			return fail(&fsError{Code: "NOSPC", Message: "ran out of temporary disk space while building the archive"})
		}
		return fail(mapOsErr(walkErr))
	}
	if err := zw.Close(); err != nil {
		if gw.spaceErr != nil {
			return fail(&fsError{Code: "NOSPC", Message: "ran out of temporary disk space while building the archive"})
		}
		return fail(mapOsErr(err))
	}
	size, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return fail(mapOsErr(err))
	}
	if err := f.Close(); err != nil {
		os.Remove(tmpPath)
		return "", 0, mapOsErr(err)
	}
	return tmpPath, size, nil
}

// isShareTempPath gates rm-temp: only our own archives, directly in the temp dir.
func isShareTempPath(p string) bool {
	clean := filepath.Clean(p)
	base := filepath.Base(clean)
	return filepath.Dir(clean) == filepath.Clean(os.TempDir()) &&
		strings.HasPrefix(base, shareZipTempPre) &&
		strings.HasSuffix(base, ".zip")
}

// sweepShareTemps removes orphaned share archives older than maxAge — the
// safety net for any build whose caller timed out or disconnected before the
// normal rm-temp cleanup ran. The disk guard prevents saturation regardless;
// this just stops leaked archives lingering in the (private) temp dir.
func sweepShareTemps(maxAge time.Duration) {
	dir := os.TempDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-maxAge)
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, shareZipTempPre) || !strings.HasSuffix(name, ".zip") {
			continue
		}
		if info, err := e.Info(); err == nil && info.ModTime().Before(cutoff) {
			os.Remove(filepath.Join(dir, name))
		}
	}
}

// ── unzip ─────────────────────────────────────────────────────────────────────

func doUnzip(archivePath, destDir string) *fsError {
	r, err := zip.OpenReader(archivePath)
	if err != nil {
		return mapOsErr(err)
	}
	defer r.Close()

	cleanDest := filepath.Clean(destDir) + string(filepath.Separator)

	for _, f := range r.File {
		// Prevent zip-slip: reject any path that escapes destDir
		target := filepath.Join(destDir, filepath.Clean("/"+f.Name))
		if target != filepath.Clean(destDir) && !strings.HasPrefix(target, cleanDest) {
			return &fsError{Code: "ERR", Message: "zip entry escapes destination: " + f.Name}
		}

		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, f.Mode()|0111); err != nil {
				return mapOsErr(err)
			}
			continue
		}

		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return mapOsErr(err)
		}

		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode())
		if err != nil {
			return mapOsErr(err)
		}

		rc, err := f.Open()
		if err != nil {
			out.Close()
			return mapOsErr(err)
		}

		_, copyErr := io.Copy(out, rc)
		out.Close()
		rc.Close()

		if copyErr != nil {
			return mapOsErr(copyErr)
		}
	}
	return nil
}

// ── disk listing ──────────────────────────────────────────────────────────────

type diskInfo struct {
	Device     string `json:"device"`
	MountPoint string `json:"mountPoint"`
	FsType     string `json:"fsType"`
	Total      int64  `json:"total"`
	Used       int64  `json:"used"`
	Free       int64  `json:"free"`
}

type raidArray struct {
	Name    string   `json:"name"`
	Level   string   `json:"level"`
	State   string   `json:"state"`
	Devices []string `json:"devices"`
	Active  int      `json:"active"`
	Total   int      `json:"total"`
}

type disksResult struct {
	Disks []diskInfo  `json:"disks"`
	Raids []raidArray `json:"raids"`
}

var skipFsTypes = map[string]bool{
	"proc": true, "sysfs": true, "devtmpfs": true, "devpts": true,
	"cgroup": true, "cgroup2": true, "pstore": true, "securityfs": true,
	"debugfs": true, "hugetlbfs": true, "mqueue": true, "fusectl": true,
	"configfs": true, "efivarfs": true, "bpf": true, "tracefs": true,
	"autofs": true, "ramfs": true,
}

func doListDisks() (*disksResult, *fsError) {
	data, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return nil, mapOsErr(err)
	}

	var disks []diskInfo
	seenMount := map[string]bool{}

	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		device, mountpoint, fstype := fields[0], fields[1], fields[2]

		if skipFsTypes[fstype] {
			continue
		}
		// Only real block devices and RAID arrays
		if !strings.HasPrefix(device, "/dev/") {
			continue
		}
		// Skip loop devices (snaps, flatpaks, etc.) and devpts
		if strings.HasPrefix(device, "/dev/loop") {
			continue
		}
		if seenMount[mountpoint] {
			continue
		}
		seenMount[mountpoint] = true

		var st syscall.Statfs_t
		if err := syscall.Statfs(mountpoint, &st); err != nil {
			continue
		}

		bsize := int64(st.Bsize)
		total := int64(st.Blocks) * bsize
		free := int64(st.Bavail) * bsize
		used := total - int64(st.Bfree)*bsize

		disks = append(disks, diskInfo{
			Device:     device,
			MountPoint: mountpoint,
			FsType:     fstype,
			Total:      total,
			Used:       used,
			Free:       free,
		})
	}
	if disks == nil {
		disks = []diskInfo{}
	}

	mdData, _ := os.ReadFile("/proc/mdstat")
	raids := parseMdstat(string(mdData))

	return &disksResult{Disks: disks, Raids: raids}, nil
}

func parseMdstat(content string) []raidArray {
	lines := strings.Split(content, "\n")
	var raids []raidArray

	for i, line := range lines {
		if !strings.HasPrefix(line, "md") || !strings.Contains(line, " : ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}

		name := fields[0]
		state := fields[2]
		level := fields[3]

		var devs []string
		for _, f := range fields[4:] {
			if idx := strings.Index(f, "["); idx > 0 {
				devs = append(devs, f[:idx])
			}
		}

		active, total := 0, 0
		// Next line: "   NNNNN blocks ... [T/A] [UU_...]"
		for j := i + 1; j < len(lines) && j <= i+3; j++ {
			next := lines[j]
			if start := strings.Index(next, "["); start >= 0 {
				if end := strings.Index(next[start:], "]"); end >= 0 {
					parts := strings.SplitN(next[start+1:start+end], "/", 2)
					if len(parts) == 2 {
						total, _ = strconv.Atoi(strings.TrimSpace(parts[0]))
						active, _ = strconv.Atoi(strings.TrimSpace(parts[1]))
					}
					break
				}
			}
		}

		raids = append(raids, raidArray{
			Name:    name,
			Level:   level,
			State:   state,
			Devices: devs,
			Active:  active,
			Total:   total,
		})
	}

	if raids == nil {
		return []raidArray{}
	}
	return raids
}
