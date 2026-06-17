package main

import (
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
	return &statResult{Mode: mode, Owner: ownerName, Group: groupName, Uid: uid, Gid: gid, Type: typ, Size: size}, nil
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
	if err := os.MkdirAll(target, 0755); err != nil {
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
	out, err := os.OpenFile(destFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
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
