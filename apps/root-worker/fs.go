package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// ── Path validation ───────────────────────────────────────────────────────────

func validatePath(p string) error {
	if strings.ContainsRune(p, 0) {
		return fmt.Errorf("invalid path: null byte")
	}
	if !filepath.IsAbs(filepath.Clean(p)) {
		return fmt.Errorf("invalid path: must be absolute")
	}
	// A place's trash (#200) is reached only through the trash operations,
	// which keep each user to their own items.
	for _, part := range strings.Split(filepath.Clean(p), "/") {
		if part == trashDirName {
			return fmt.Errorf("the trash is reached from the Trash view")
		}
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
// root disables the check, used for admin/root-level operations that are
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

// openScopedDirectory resolves a validated destination beneath allowedRoot,
// then walks it from an open root directory without following symlinks. The
// resulting descriptor remains anchored to that directory even if its path is
// renamed while the operation runs.
func openScopedDirectory(dir, allowedRoot string) (int, error) {
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return -1, err
	}
	realRoot := "/"
	if allowedRoot != "" {
		realRoot, err = filepath.EvalSymlinks(allowedRoot)
		if err != nil {
			return -1, err
		}
	}
	rel, err := filepath.Rel(realRoot, realDir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return -1, fmt.Errorf("directory escapes allowed root")
	}

	fd, err := unix.Open(realRoot, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	if rel == "." {
		return fd, nil
	}
	for _, component := range strings.Split(rel, string(filepath.Separator)) {
		next, openErr := unix.Openat(fd, component, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		_ = unix.Close(fd)
		if openErr != nil {
			return -1, openErr
		}
		fd = next
	}
	return fd, nil
}

// openRegularNoFollowAt opens a file relative to a trusted directory
// descriptor and rejects links, special files, and multiply-linked inodes.
// O_NONBLOCK avoids hanging while rejecting a FIFO in an attacker-controlled
// upload directory.
func openRegularNoFollowAt(dirFD int, name string, flags int, perm uint32) (*os.File, error) {
	fd, err := unix.Openat(dirFD, name, flags|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, perm)
	if err != nil {
		return nil, err
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("upload part is not a regular file")
	}
	if st.Nlink != 1 {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("upload part has multiple hard links")
	}
	return os.NewFile(uintptr(fd), name), nil
}

// rejectSymlinkComponents verifies that every existing component below root is
// a real directory/file rather than a symbolic link. resolveExisting(root)
// deliberately allows the configured Place root itself to be a symlink, but no
// archive entry beneath it may redirect extraction outside that root.
func rejectSymlinkComponents(root, target string) error {
	cleanRoot := filepath.Clean(root)
	cleanTarget := filepath.Clean(target)
	rel, err := filepath.Rel(cleanRoot, cleanTarget)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path escapes destination root")
	}
	if rel == "." {
		return nil
	}

	realRoot, err := resolveExisting(cleanRoot)
	if err != nil {
		return err
	}
	cur := realRoot
	for _, component := range strings.Split(rel, string(filepath.Separator)) {
		cur = filepath.Join(cur, component)
		info, statErr := os.Lstat(cur)
		if os.IsNotExist(statErr) {
			// Once a component is absent, no deeper component can exist yet.
			return nil
		}
		if statErr != nil {
			return statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: %s", errRefuseSymlink, cur)
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

var (
	errRefuseSymlink     = errors.New("refusing to follow symbolic link")
	errUnsupportedFsType = errors.New("unsupported filesystem entry type")
)

func mapOsErr(err error) *fsError {
	if errors.Is(err, errRefuseSymlink) {
		return &fsError{Code: "EACCES", Message: err.Error()}
	}
	if errors.Is(err, errUnsupportedFsType) {
		return &fsError{Code: "ERR", Message: err.Error()}
	}
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
	} else if errors.As(err, &errno) {
		// Direct syscall/xattr errors are not wrapped in PathError.
	}
	switch errno {
	case syscall.EACCES, syscall.EPERM, syscall.ELOOP:
		return &fsError{Code: "EACCES", Message: "permission denied"}
	case syscall.ENOENT:
		return &fsError{Code: "ENOENT", Message: "no such file or directory"}
	case syscall.EEXIST, syscall.ENOTEMPTY:
		return &fsError{Code: "EEXIST", Message: "destination already exists"}
	case syscall.ENOSPC, syscall.EDQUOT:
		return &fsError{Code: "ENOSPC", Message: "no space left on device"}
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
	statExtras
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
	return &statResult{Mode: mode, Owner: ownerName, Group: groupName, Uid: uid, Gid: gid, Type: typ, Size: size, Mtime: mtime, Ctime: ctime,
		statExtras: fillStatExtras(path, info, sys)}, nil
}

// ── disk usage ───────────────────────────────────────────────────────────────

type diskUsageResult struct {
	Total int64 `json:"total"`
	Free  int64 `json:"free"`
	// Filesystem holding the path (#198); empty when unknown.
	FsType     string `json:"fsType,omitempty"`
	MountPoint string `json:"mountPoint,omitempty"`
	Source     string `json:"source,omitempty"`
}

func doDiskUsage(path string) (*diskUsageResult, *fsError) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return nil, mapOsErr(err)
	}
	bsize := int64(st.Bsize)
	r := &diskUsageResult{
		Total:  int64(st.Blocks) * bsize,
		Free:   int64(st.Bavail) * bsize, // Bavail = available to non-root
		FsType: fsTypeName(int64(st.Type)),
	}
	if info, err := os.ReadFile("/proc/self/mountinfo"); err == nil {
		r.MountPoint, r.Source = mountOf(string(info), path)
	}
	return r, nil
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

// ── touch ─────────────────────────────────────────────────────────────────────

type touchResult struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

func doTouch(parent, name string) (*touchResult, *fsError) {
	if name == "" {
		name = "New File"
	}
	target := filepath.Join(parent, name)
	for n := 1; n <= 1000; n++ {
		f, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0664)
		if err == nil {
			f.Close()
			return &touchResult{Path: target, Name: filepath.Base(target)}, nil
		}
		if !os.IsExist(err) {
			return nil, mapOsErr(err)
		}
		target = filepath.Join(parent, fmt.Sprintf("%s (%d)", name, n))
	}
	return nil, &fsError{Code: "EEXIST", Message: "could not find a unique name after 1000 attempts"}
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

func copyAll(ctx context.Context, src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: %s", errRefuseSymlink, src)
	}
	if info.IsDir() {
		return copyDir(ctx, src, dst, info)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%w: %s", errUnsupportedFsType, src)
	}
	return copyFile(ctx, src, dst)
}

// copyChunk is how much a file copy moves between two looks at its context:
// small enough to stop a cancelled copy within a second or so, large enough to
// keep the kernel's copy_file_range doing the work.
const copyChunk = 64 << 20

// copyContents copies in to out, stopping between chunks once ctx is cancelled.
func copyContents(ctx context.Context, out *os.File, in *os.File) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, err := io.CopyN(out, in, copyChunk)
		addProgress(ctx, n)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func copyFile(ctx context.Context, src, dst string) error {
	// O_NOFOLLOW closes the race where a checked regular file is swapped for a
	// symlink before it is opened. Without it, a link nested in an allowed Place
	// could disclose the contents of an arbitrary file outside that Place.
	in, err := os.OpenFile(src, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%w: %s", errUnsupportedFsType, src)
	}
	// The destination selected by uniqueDst must not exist. O_EXCL avoids a
	// check/open race and O_NOFOLLOW prevents overwriting through a planted link.
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, info.Mode().Perm())
	if err != nil {
		return err
	}
	completed := false
	defer func() {
		if !completed {
			_ = out.Close()
			_ = os.Remove(dst)
		}
	}()
	if err := copyContents(ctx, out, in); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	completed = true
	return nil
}

func copyDir(ctx context.Context, src, dst string, info fs.FileInfo) error {
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: %s", errRefuseSymlink, src)
	}
	// Open the source directory itself without following a last-component link.
	// ReadDir on the descriptor also keeps the directory stable while enumerating.
	in, err := os.OpenFile(src, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer in.Close()
	actual, err := in.Stat()
	if err != nil {
		return err
	}
	if !actual.IsDir() {
		return fmt.Errorf("%w: %s", errUnsupportedFsType, src)
	}
	// dst is chosen as a non-existent unique path. Mkdir (not MkdirAll) fails
	// safely if another process plants a file/link between selection and create.
	if err := os.Mkdir(dst, actual.Mode().Perm()); err != nil {
		return err
	}
	completed := false
	defer func() {
		if !completed {
			_ = os.RemoveAll(dst)
		}
	}()
	entries, err := in.ReadDir(-1)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())
		ei, err := os.Lstat(s)
		if err != nil {
			return err
		}
		if ei.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: %s", errRefuseSymlink, s)
		}
		if ei.IsDir() {
			if err := copyDir(ctx, s, d, ei); err != nil {
				return err
			}
		} else if ei.Mode().IsRegular() {
			if err := copyFile(ctx, s, d); err != nil {
				return err
			}
		} else {
			return fmt.Errorf("%w: %s", errUnsupportedFsType, s)
		}
	}
	completed = true
	return nil
}

// What a copy or move does when its name is already taken in the destination,
// as the user chose it: number it ("Films (1)"), replace the existing item, or
// leave both as they are. A move with no choice keeps refusing (EEXIST).
const (
	conflictRename  = "rename"
	conflictReplace = "replace"
	conflictSkip    = "skip"
)

// hiddenSibling is a name for staging next to target that nothing else uses.
var hiddenSeq uint64

func hiddenSibling(target, what string) string {
	hiddenSeq++
	return filepath.Join(filepath.Dir(target), fmt.Sprintf(".hsi-%s-%d-%d", what, time.Now().UnixNano(), hiddenSeq))
}

// swapInto puts staged where target is, then removes the old target. The old
// item is only deleted once the new one is in place.
func swapInto(target, staged string) error {
	old := hiddenSibling(target, "replaced")
	if err := os.Rename(target, old); err != nil {
		return err
	}
	if err := os.Rename(staged, target); err != nil {
		_ = os.Rename(old, target)
		return err
	}
	if err := os.RemoveAll(old); err != nil {
		logger.Warn("replace: the replaced item could not be removed", "path", old, "error", err)
	}
	return nil
}

// errReplaceHolder: replacing the folder that holds the item would delete it.
var errReplaceHolder = &fsError{Code: "EINVAL", Message: "cannot replace the folder that holds the item"}

func holds(dir, path string) bool {
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func doCopy(ctx context.Context, src, dstDir, onConflict string) (*copyResult, *fsError) {
	target := filepath.Join(dstDir, filepath.Base(src))
	_, statErr := os.Lstat(target)
	taken := statErr == nil && filepath.Clean(target) != filepath.Clean(src)
	switch {
	case taken && onConflict == conflictSkip:
		return &copyResult{Ok: true, Dst: target}, nil
	case taken && onConflict == conflictReplace:
		if holds(target, src) {
			return nil, errReplaceHolder
		}
		staged := hiddenSibling(target, "copy")
		if err := copyAll(ctx, src, staged); err != nil {
			return nil, asFsErr(err) // copyAll removed what it wrote
		}
		if err := swapInto(target, staged); err != nil {
			_ = os.RemoveAll(staged)
			return nil, mapOsErr(err)
		}
		return &copyResult{Ok: true, Dst: target}, nil
	}
	dst := uniqueDst(src, dstDir)
	if err := copyAll(ctx, src, dst); err != nil {
		return nil, asFsErr(err)
	}
	return &copyResult{Ok: true, Dst: dst}, nil
}

// ── move ──────────────────────────────────────────────────────────────────────

type moveResult struct {
	Ok  bool   `json:"ok"`
	Dst string `json:"dst"`
}

func doMove(ctx context.Context, src, dstDir, onConflict string) (*moveResult, *fsError) {
	dst := filepath.Join(dstDir, filepath.Base(src))
	if _, err := os.Lstat(dst); err == nil && filepath.Clean(dst) != filepath.Clean(src) {
		switch onConflict {
		case conflictSkip:
			return &moveResult{Ok: true, Dst: dst}, nil
		case conflictReplace:
			if fsErr := moveReplacing(ctx, src, dst); fsErr != nil {
				return nil, fsErr
			}
			return &moveResult{Ok: true, Dst: dst}, nil
		case conflictRename:
			dst = uniqueDst(src, dstDir)
		default:
			return nil, &fsError{Code: "EEXIST", Message: "destination already exists"}
		}
	}
	err := os.Rename(src, dst)
	if err != nil {
		var linkErr *os.LinkError
		if errors.As(err, &linkErr) {
			if errno, ok := linkErr.Err.(syscall.Errno); ok && errno == syscall.EXDEV {
				if fsErr := moveByCopy(ctx, src, dst); fsErr != nil {
					return nil, fsErr
				}
				return &moveResult{Ok: true, Dst: dst}, nil
			}
		}
		return nil, mapOsErr(err)
	}
	return &moveResult{Ok: true, Dst: dst}, nil
}

// moveReplacing moves src over the existing target: staged beside it first
// (a rename, or a copy across filesystems), swapped in, and only then are the
// old target and, for a copy, the source removed. On failure src stays.
func moveReplacing(ctx context.Context, src, target string) *fsError {
	if holds(target, src) {
		return errReplaceHolder
	}
	staged := hiddenSibling(target, "move")
	copied := false
	if err := os.Rename(src, staged); err != nil {
		var linkErr *os.LinkError
		if !errors.As(err, &linkErr) || linkErr.Err != syscall.EXDEV {
			return mapOsErr(err)
		}
		if err := copyAll(ctx, src, staged); err != nil {
			return asFsErr(err)
		}
		copied = true
	}
	if err := swapInto(target, staged); err != nil {
		if copied {
			_ = os.RemoveAll(staged)
		} else {
			_ = os.Rename(staged, src)
		}
		return mapOsErr(err)
	}
	if copied {
		if err := os.RemoveAll(src); err != nil {
			return mapOsErr(err)
		}
	}
	return nil
}

// moveByCopy moves across filesystems: copy, then remove the source. A cancel
// during the copy removes the partial destination and keeps the source; once
// the copy is complete the move finishes.
func moveByCopy(ctx context.Context, src, dst string) *fsError {
	if err := copyAll(ctx, src, dst); err != nil {
		return asFsErr(err)
	}
	if err := os.RemoveAll(src); err != nil {
		return mapOsErr(err)
	}
	return nil
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

// ── finalize ──────────────────────────────────────────────────────────────────

// doFinalize verifies the whole-file SHA-256 of the uploaded temp file and,
// on match, atomically renames it into place (same directory, so rename
// never crosses a filesystem). On mismatch the temp file is removed so no
// corrupt partial is left behind.
func doFinalize(tempFile, destFile, allowedRoot, expectedSha string) *fsError {
	tempDir := filepath.Dir(filepath.Clean(tempFile))
	destDir := filepath.Dir(filepath.Clean(destFile))
	if tempDir != destDir {
		return &fsError{Code: "ERR", Message: "upload temp and destination must be in the same directory"}
	}
	dirFD, err := openScopedDirectory(tempDir, allowedRoot)
	if err != nil {
		return mapOsErr(err)
	}
	defer unix.Close(dirFD)
	tempName := filepath.Base(tempFile)
	destName := filepath.Base(destFile)
	f, err := openRegularNoFollowAt(dirFD, tempName, unix.O_RDONLY, 0)
	if err != nil {
		return mapOsErr(err)
	}
	h := sha256.New()
	_, cpErr := io.Copy(h, f)
	closeErr := f.Close()
	if cpErr != nil {
		return &fsError{Code: "ERR", Message: cpErr.Error()}
	}
	if closeErr != nil {
		return mapOsErr(closeErr)
	}

	if expectedSha != "" && hex.EncodeToString(h.Sum(nil)) != strings.ToLower(expectedSha) {
		_ = unix.Unlinkat(dirFD, tempName, 0)
		return &fsError{Code: "ECHECKSUM", Message: "checksum mismatch: file corrupted in transfer"}
	}

	if err := unix.Renameat(dirFD, tempName, dirFD, destName); err != nil {
		return mapOsErr(err)
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

func addZipRegular(ctx context.Context, zw *zip.Writer, archiveName, srcPath string) error {
	in, err := os.OpenFile(srcPath, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	info, err := in.Stat()
	if err != nil {
		in.Close()
		return err
	}
	if !info.Mode().IsRegular() {
		in.Close()
		return fmt.Errorf("%w: %s", errUnsupportedFsType, srcPath)
	}
	w, err := zw.Create(filepath.ToSlash(archiveName))
	if err != nil {
		in.Close()
		return err
	}
	_, copyErr := io.Copy(w, ctxReader{ctx, in})
	closeErr := in.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

type replacementMetadata struct {
	mode      os.FileMode
	uid       int
	gid       int
	existing  bool
	accessACL []byte
}

const workerCreateMask os.FileMode = 0002

// replacementPolicy determines the final mode before an atomic rename. For an
// existing target it also opens the target for writing (without following a
// symlink), preserving the old permission boundary and its extended ACL/xattr
// metadata. New files use a fixed application policy filtered through umask.
func replacementPolicy(target string, newMode os.FileMode) (replacementMetadata, error) {
	existing, err := os.OpenFile(target, os.O_WRONLY|syscall.O_NOFOLLOW, 0)
	if err == nil {
		defer existing.Close()
		info, statErr := existing.Stat()
		if statErr != nil {
			return replacementMetadata{}, statErr
		}
		if !info.Mode().IsRegular() {
			return replacementMetadata{}, fmt.Errorf("%w: %s", errUnsupportedFsType, target)
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return replacementMetadata{}, fmt.Errorf("could not read owner metadata for %s", target)
		}
		accessACL, aclErr := readOptionalXattr(int(existing.Fd()), "system.posix_acl_access")
		if aclErr != nil {
			return replacementMetadata{}, aclErr
		}
		return replacementMetadata{
			mode: info.Mode().Perm(), uid: int(stat.Uid), gid: int(stat.Gid),
			existing: true, accessACL: accessACL,
		}, nil
	}
	if !os.IsNotExist(err) {
		return replacementMetadata{}, err
	}
	return replacementMetadata{mode: newMode.Perm() &^ workerCreateMask}, nil
}

func readOptionalXattr(fd int, name string) ([]byte, error) {
	size, err := unix.Fgetxattr(fd, name, nil)
	if err != nil {
		if errors.Is(err, syscall.ENODATA) || errors.Is(err, syscall.ENOTSUP) || errors.Is(err, syscall.EOPNOTSUPP) {
			return nil, nil
		}
		return nil, err
	}
	value := make([]byte, size)
	if size == 0 {
		return value, nil
	}
	n, err := unix.Fgetxattr(fd, name, value)
	if err != nil {
		return nil, err
	}
	return value[:n], nil
}

func applyReplacementMetadata(file *os.File, metadata replacementMetadata) error {
	if metadata.existing {
		// Atomic replacement must retain the old inode's ownership. If the
		// impersonated caller cannot preserve it, fail instead of silently
		// transferring ownership to the caller. Do not copy security.* xattrs:
		// in-place writes would invalidate capabilities/signatures as well.
		if err := file.Chown(metadata.uid, metadata.gid); err != nil {
			return err
		}
		if metadata.accessACL != nil {
			if err := unix.Fsetxattr(int(file.Fd()), "system.posix_acl_access", metadata.accessACL, 0); err != nil {
				return err
			}
		} else if err := unix.Fremovexattr(int(file.Fd()), "system.posix_acl_access"); err != nil &&
			!errors.Is(err, syscall.ENODATA) && !errors.Is(err, syscall.ENOTSUP) && !errors.Is(err, syscall.EOPNOTSUPP) {
			return err
		}
	}
	if err := file.Chmod(metadata.mode); err != nil {
		return err
	}
	return nil
}

func doZip(ctx context.Context, paths []string, destDir, name string) *fsError {
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
	if err := rejectSymlinkComponents(destDir, zipPath); err != nil {
		return mapOsErr(err)
	}
	_, err := replacementPolicy(zipPath, 0666)
	if err != nil {
		return mapOsErr(err)
	}
	// Build beside the final path and only replace it after the whole archive is
	// valid. This preserves an existing archive when a source fails part-way and
	// also keeps `zipPath` readable when it is itself one of the selected files.
	f, err := os.CreateTemp(destDir, ".hsi-zip-*.tmp")
	if err != nil {
		return mapOsErr(err)
	}
	tmpPath := f.Name()
	zw := zip.NewWriter(f)
	fail := func(err error) *fsError {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return asFsErr(err)
	}

	for _, src := range paths {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		info, err := os.Lstat(src)
		if err != nil {
			return fail(err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fail(fmt.Errorf("%w: %s", errRefuseSymlink, src))
		}
		parentDir := filepath.Dir(src)
		if info.IsDir() {
			if walkErr := filepath.Walk(src, func(walkPath string, fi fs.FileInfo, err error) error {
				if err != nil {
					return err
				}
				if fi.Mode()&os.ModeSymlink != 0 {
					return fmt.Errorf("%w: %s", errRefuseSymlink, walkPath)
				}
				if fi.IsDir() {
					return nil
				}
				if !fi.Mode().IsRegular() {
					return fmt.Errorf("%w: %s", errUnsupportedFsType, walkPath)
				}
				// If the temporary output lives inside a selected directory, never
				// recursively add the archive while it is being written. Preserve the
				// historical behaviour of excluding an existing final archive too.
				if filepath.Clean(walkPath) == filepath.Clean(tmpPath) ||
					filepath.Clean(walkPath) == filepath.Clean(zipPath) {
					return nil
				}
				rel, err := filepath.Rel(parentDir, walkPath)
				if err != nil {
					return err
				}
				return addZipRegular(ctx, zw, rel, walkPath)
			}); walkErr != nil {
				return fail(walkErr)
			}
		} else if info.Mode().IsRegular() {
			if err := addZipRegular(ctx, zw, filepath.Base(src), src); err != nil {
				return fail(err)
			}
		} else {
			return fail(fmt.Errorf("%w: %s", errUnsupportedFsType, src))
		}
	}
	if err := zw.Close(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return mapOsErr(err)
	}
	metadata, err := replacementPolicy(zipPath, 0666)
	if err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return mapOsErr(err)
	}
	if err := applyReplacementMetadata(f, metadata); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return mapOsErr(err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return mapOsErr(err)
	}
	// Rename replaces a regular final file atomically without ever following it.
	// The earlier component check retains the API's explicit symlink rejection.
	if err := os.Rename(tmpPath, zipPath); err != nil {
		_ = os.Remove(tmpPath)
		return mapOsErr(err)
	}
	return nil
}

// ── zip to temp (public share "download all") ──────────────────────────────────
//
// Builds a zip of a directory into the worker's temp dir, streamed
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
	if info.Mode()&os.ModeSymlink != 0 {
		return "", 0, mapOsErr(fmt.Errorf("%w: %s", errRefuseSymlink, srcPath))
	}
	if !info.IsDir() {
		return "", 0, &fsError{Code: "ERR", Message: "not a directory"}
	}
	tmpDir := os.TempDir()

	// Pre-flight early-reject: the uncompressed total is a rough size estimate
	// (not a strict upper bound: zip adds per-entry header overhead). The real
	// guarantee against filling the disk is the guardedWriter below, which
	// re-checks actual free space as it writes.
	var total int64
	if walkErr := filepath.Walk(srcPath, func(walkPath string, fi fs.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: %s", errRefuseSymlink, walkPath)
		}
		if fi.IsDir() {
			return nil
		}
		if !fi.Mode().IsRegular() {
			return fmt.Errorf("%w: %s", errUnsupportedFsType, walkPath)
		}
		total += fi.Size()
		if total > shareZipMaxInput {
			return errZipTooBig
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
		if err != nil {
			return err
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: %s", errRefuseSymlink, walkPath)
		}
		if fi.IsDir() {
			return nil
		}
		if !fi.Mode().IsRegular() {
			return fmt.Errorf("%w: %s", errUnsupportedFsType, walkPath)
		}
		rel, err := filepath.Rel(parentDir, walkPath)
		if err != nil {
			return err
		}
		return addZipRegular(context.Background(), zw, rel, walkPath)
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

// sweepShareTemps removes orphaned share archives older than maxAge; the
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

// afterUnzipEntry runs after each extracted entry (tests cancel mid-way with it).
var afterUnzipEntry func(i int)

// unzipUndo remembers what an extraction created, so a cancel removes exactly
// that: files it replaced keep their new content, nothing else is touched.
type unzipUndo struct {
	root  string // the extraction folder: nothing outside it is removed
	files []string
	dirs  []string
}

// noteDirs records the directories MkdirAll is about to create under root.
func (u *unzipUndo) noteDirs(root, dir string) {
	var missing []string
	for d := dir; d != root && strings.HasPrefix(d, root+string(filepath.Separator)); d = filepath.Dir(d) {
		if _, err := os.Lstat(d); err == nil {
			break
		}
		missing = append(missing, d)
	}
	// Outermost first, so removal in reverse goes deepest first.
	for i := len(missing) - 1; i >= 0; i-- {
		u.dirs = append(u.dirs, missing[i])
	}
}

// undo removes them again, never through a folder swapped for a link since.
func (u *unzipUndo) undo() {
	for _, f := range u.files {
		if rejectSymlinkComponents(u.root, f) == nil {
			_ = os.Remove(f)
		}
	}
	for i := len(u.dirs) - 1; i >= 0; i-- {
		if rejectSymlinkComponents(u.root, u.dirs[i]) == nil {
			_ = os.Remove(u.dirs[i]) // only if empty
		}
	}
}

func doUnzip(ctx context.Context, archivePath, destDir string) *fsError {
	archive, err := os.OpenFile(archivePath, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return mapOsErr(err)
	}
	defer archive.Close()
	archiveInfo, err := archive.Stat()
	if err != nil {
		return mapOsErr(err)
	}
	if !archiveInfo.Mode().IsRegular() {
		return mapOsErr(fmt.Errorf("%w: %s", errUnsupportedFsType, archivePath))
	}
	r, err := zip.NewReader(archive, archiveInfo.Size())
	if err != nil {
		return mapOsErr(err)
	}

	type validatedEntry struct {
		file      *zip.File
		entryPath string
		target    string
		isDir     bool
	}
	entries := make([]validatedEntry, 0, len(r.File))
	kinds := make(map[string]bool, len(r.File)) // true = directory
	requiredDirs := map[string]bool{".": true}
	files := make(map[string]bool, len(r.File))

	for _, f := range r.File {
		// Validate every entry before creating or replacing anything. A malformed
		// late entry must not leave earlier files partially extracted.
		if strings.ContainsRune(f.Name, 0) {
			return &fsError{Code: "ERR", Message: "zip entry contains a null byte"}
		}
		entryPath := filepath.Clean(filepath.FromSlash(f.Name))
		if !filepath.IsLocal(entryPath) || filepath.IsAbs(entryPath) || entryPath == ".." || strings.HasPrefix(entryPath, ".."+string(filepath.Separator)) {
			return &fsError{Code: "ERR", Message: "zip entry escapes destination: " + f.Name}
		}
		if f.Mode()&os.ModeSymlink != 0 {
			return mapOsErr(fmt.Errorf("%w: archive entry %s", errRefuseSymlink, f.Name))
		}
		isDir := f.FileInfo().IsDir()
		if !isDir && !f.Mode().IsRegular() {
			return mapOsErr(fmt.Errorf("%w: archive entry %s", errUnsupportedFsType, f.Name))
		}
		if entryPath == "." && !isDir {
			return &fsError{Code: "ERR", Message: "invalid zip entry: " + f.Name}
		}
		if priorKind, exists := kinds[entryPath]; exists {
			if priorKind != isDir || !isDir {
				return &fsError{Code: "ERR", Message: "conflicting zip entry: " + f.Name}
			}
			continue
		}
		for parent := filepath.Dir(entryPath); parent != "."; parent = filepath.Dir(parent) {
			if files[parent] {
				return &fsError{Code: "ERR", Message: "zip entry has a file as parent: " + f.Name}
			}
			requiredDirs[parent] = true
		}
		if isDir {
			if files[entryPath] {
				return &fsError{Code: "ERR", Message: "conflicting zip entry: " + f.Name}
			}
		} else {
			if requiredDirs[entryPath] {
				return &fsError{Code: "ERR", Message: "zip entry conflicts with a directory: " + f.Name}
			}
			files[entryPath] = true
		}
		kinds[entryPath] = isDir
		target := filepath.Join(destDir, entryPath)
		if err := rejectSymlinkComponents(destDir, target); err != nil {
			return mapOsErr(err)
		}
		if current, statErr := os.Lstat(target); statErr == nil {
			if current.Mode()&os.ModeSymlink != 0 {
				return mapOsErr(fmt.Errorf("%w: %s", errRefuseSymlink, target))
			}
			if isDir != current.IsDir() || (!isDir && !current.Mode().IsRegular()) {
				return mapOsErr(fmt.Errorf("%w: %s", errUnsupportedFsType, target))
			}
		} else if !os.IsNotExist(statErr) {
			return mapOsErr(statErr)
		}
		if !isDir {
			// Preflight the same permission check used immediately before commit.
			// A writable parent alone must not permit replacing a read-only file.
			if _, err := replacementPolicy(target, f.Mode().Perm()&0775); err != nil {
				return mapOsErr(err)
			}
		}
		entries = append(entries, validatedEntry{file: f, entryPath: entryPath, target: target, isDir: isDir})
	}

	undo := unzipUndo{root: destDir}
	cancelled := func() *fsError {
		undo.undo()
		return errCancelled
	}
	for i, entry := range entries {
		if i > 0 && afterUnzipEntry != nil {
			afterUnzipEntry(i - 1)
		}
		if ctx.Err() != nil {
			return cancelled()
		}
		f := entry.file
		target := entry.target
		if entry.isDir {
			undo.noteDirs(destDir, target)
			if err := os.MkdirAll(target, f.Mode().Perm()|0111); err != nil {
				return mapOsErr(err)
			}
			continue
		}

		undo.noteDirs(destDir, filepath.Dir(target))
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return mapOsErr(err)
		}
		// Re-check after MkdirAll, then use O_NOFOLLOW for the final component.
		if err := rejectSymlinkComponents(destDir, target); err != nil {
			return mapOsErr(err)
		}

		rc, err := f.Open()
		if err != nil {
			return mapOsErr(err)
		}
		out, err := os.CreateTemp(filepath.Dir(target), ".hsi-unzip-*.tmp")
		if err != nil {
			rc.Close()
			return mapOsErr(err)
		}
		tmpPath := out.Name()

		_, copyErr := io.Copy(out, ctxReader{ctx, rc})
		rcCloseErr := rc.Close()
		if copyErr != nil {
			_ = out.Close()
			_ = os.Remove(tmpPath)
			if ctx.Err() != nil {
				return cancelled()
			}
			return mapOsErr(copyErr)
		}
		if rcCloseErr != nil {
			_ = out.Close()
			_ = os.Remove(tmpPath)
			return mapOsErr(rcCloseErr)
		}
		metadata, metadataErr := replacementPolicy(target, f.Mode().Perm()&0775)
		if metadataErr != nil {
			_ = out.Close()
			_ = os.Remove(tmpPath)
			return mapOsErr(metadataErr)
		}
		if err := applyReplacementMetadata(out, metadata); err != nil {
			_ = out.Close()
			_ = os.Remove(tmpPath)
			return mapOsErr(err)
		}
		if err := out.Close(); err != nil {
			_ = os.Remove(tmpPath)
			return mapOsErr(err)
		}
		if err := rejectSymlinkComponents(destDir, target); err != nil {
			_ = os.Remove(tmpPath)
			return mapOsErr(err)
		}
		_, beforeErr := os.Lstat(target)
		if err := os.Rename(tmpPath, target); err != nil {
			_ = os.Remove(tmpPath)
			return mapOsErr(err)
		}
		if beforeErr != nil { // it did not exist: this extraction created it
			undo.files = append(undo.files, target)
		}
	}
	if len(entries) > 0 && afterUnzipEntry != nil {
		afterUnzipEntry(len(entries) - 1)
	}
	if ctx.Err() != nil {
		return cancelled()
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
	Name          string   `json:"name"`
	Level         string   `json:"level"`
	State         string   `json:"state"`
	Devices       []string `json:"devices"`
	Active        int      `json:"active"`
	Total         int      `json:"total"`
	ResyncPercent *float64 `json:"resyncPercent,omitempty"`
	// SyncAction is what the progress is for: "recovery" (rebuilding onto a
	// new member), "resync", "check" or "reshape".
	SyncAction string       `json:"syncAction,omitempty"`
	Members    []raidMember `json:"members"`
	// After a consistency check (last_sync_action = check): sectors found out
	// of sync. Non-zero on RAID 5/6 means silent corruption or a failing disk.
	LastCheck     string `json:"lastCheck,omitempty"`
	MismatchCount *int64 `json:"mismatchCount,omitempty"`
}

// addCheckResults reads the last consistency-check outcome from sysfs.
func addCheckResults(raids []raidArray) {
	for i := range raids {
		base := "/sys/block/" + raids[i].Name + "/md/"
		last, err := os.ReadFile(base + "last_sync_action")
		if err != nil {
			continue
		}
		raids[i].LastCheck = strings.TrimSpace(string(last))
		if raids[i].LastCheck != "check" || raids[i].ResyncPercent != nil {
			continue
		}
		if cnt, err := os.ReadFile(base + "mismatch_cnt"); err == nil {
			if n, err := strconv.ParseInt(strings.TrimSpace(string(cnt)), 10, 64); err == nil {
				raids[i].MismatchCount = &n
			}
		}
	}
}

// raidMember is one device of an array as /proc/mdstat lists it.
type raidMember struct {
	Name string `json:"name"`
	Role string `json:"role"` // active | faulty | spare
}

// memberFromMdstat parses "sdb1[1]", "sdc[2](F)" or "sdd[3](S)".
func memberFromMdstat(tok string) (raidMember, bool) {
	i := strings.Index(tok, "[")
	if i <= 0 {
		return raidMember{}, false
	}
	m := raidMember{Name: tok[:i], Role: "active"}
	switch {
	case strings.HasSuffix(tok, "(F)"):
		m.Role = "faulty"
	case strings.HasSuffix(tok, "(S)"):
		m.Role = "spare"
	}
	return m, true
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
	markRebuilding(raids)

	return &disksResult{Disks: disks, Raids: raids}, nil
}

var reResyncPct = regexp.MustCompile(`=\s*([\d.]+)%`)

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

		// Some states carry an optional parenthetical annotation right after
		// them, e.g. "active (read-only)" / "active (auto-read-only)"; skip
		// it before looking for the level token.
		idx := 3
		if idx < len(fields) && strings.HasPrefix(fields[idx], "(") && strings.HasSuffix(fields[idx], ")") {
			idx++
		}

		devStart := idx + 1
		level := ""
		if idx < len(fields) && !strings.Contains(fields[idx], "[") {
			level = fields[idx]
		} else {
			devStart = idx
		}

		var devs []string
		members := []raidMember{}
		for _, f := range fields[devStart:] {
			if m, ok := memberFromMdstat(f); ok {
				devs = append(devs, m.Name)
				members = append(members, m)
			}
		}

		active, total := 0, 0
		var resyncPercent *float64
		syncAction := ""
		// Status line: "   NNNNN blocks ... [T/A] [UU_...]"; while rebuilding, an
		// extra progress line follows: "[===>....] recovery = 45.2% (...) ..."
		for j := i + 1; j < len(lines) && j <= i+4; j++ {
			next := lines[j]
			if strings.HasPrefix(next, "md") && strings.Contains(next, " : ") {
				break // reached the next array's own header: stop, don't inherit its data
			}
			if active == 0 && total == 0 {
				if start := strings.Index(next, "["); start >= 0 {
					if end := strings.Index(next[start:], "]"); end >= 0 {
						parts := strings.SplitN(next[start+1:start+end], "/", 2)
						if len(parts) == 2 {
							t, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
							a, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
							if err1 == nil && err2 == nil {
								total, active = t, a
							}
						}
					}
				}
			}
			for _, action := range []string{"recovery", "resync", "check", "reshape"} {
				if strings.Contains(next, action+" =") {
					if m := reResyncPct.FindStringSubmatch(next); m != nil {
						if pct, err := strconv.ParseFloat(m[1], 64); err == nil {
							resyncPercent = &pct
							syncAction = action
						}
					}
				}
			}
		}

		raids = append(raids, raidArray{
			Name:          name,
			Level:         level,
			State:         state,
			Devices:       devs,
			Active:        active,
			Total:         total,
			ResyncPercent: resyncPercent,
			SyncAction:    syncAction,
			Members:       members,
		})
	}

	if raids == nil {
		return []raidArray{}
	}
	return raids
}
