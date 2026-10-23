package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"
)

// ── Safe updates (#9a): file copies that never follow a link ─────────────────
// The database directory and some configuration files can be changed by the app
// user while root snapshots or restores them. Every copy below works from parent
// directories held by descriptor (opened one component at a time without following
// links), opens sources O_NOFOLLOW, writes to a fresh temp name and renames it over
// the target, so a link planted anywhere is never followed.

const (
	oPath             = 0x200000 // O_PATH, not exported by syscall
	atSymlinkNoFollow = 0x100
)

// statAt describes dir/name itself (a link is not followed).
func statAt(dir *os.File, name string) (syscall.Stat_t, error) {
	var st syscall.Stat_t
	fd, err := syscall.Openat(int(dir.Fd()), name, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return st, err
	}
	defer syscall.Close(fd)
	err = syscall.Fstat(fd, &st)
	return st, err
}

func readlinkAt(dir *os.File, name string) (string, error) {
	p, err := syscall.BytePtrFromString(name)
	if err != nil {
		return "", err
	}
	buf := make([]byte, 4096)
	n, _, e := syscall.Syscall6(syscall.SYS_READLINKAT, dir.Fd(), uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), 0, 0)
	if e != 0 {
		return "", e
	}
	if int(n) >= len(buf) {
		return "", fmt.Errorf("the link %s is too long", name)
	}
	return string(buf[:n]), nil
}

func symlinkAt(target string, dir *os.File, name string) error {
	t, err := syscall.BytePtrFromString(target)
	if err != nil {
		return err
	}
	p, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	if _, _, e := syscall.Syscall(syscall.SYS_SYMLINKAT, uintptr(unsafe.Pointer(t)), dir.Fd(), uintptr(unsafe.Pointer(p))); e != 0 {
		return e
	}
	return nil
}

// removeAt unlinks dir/name (never a link's target); a missing entry is fine.
func removeAt(dir *os.File, name string) error {
	if err := unlinkat(dir, name, 0); err != nil && !errors.Is(err, syscall.ENOENT) {
		return err
	}
	return nil
}

// openParentNoFollow holds the directory of an absolute path, refusing a link on the way.
func openParentNoFollow(path string) (*os.File, string, error) {
	if !filepath.IsAbs(path) {
		return nil, "", fmt.Errorf("%s is not an absolute path", path)
	}
	d, err := openDirNoFollow(filepath.Dir(path))
	if err != nil {
		return nil, "", err
	}
	return d, filepath.Base(path), nil
}

// copyAt copies srcDir/srcName to dstDir/dstName (stageAt, then a rename).
func copyAt(srcDir *os.File, srcName string, dstDir *os.File, dstName string, mode os.FileMode, allowLink bool) error {
	tmp, err := stageAt(srcDir, srcName, dstDir, dstName, mode, allowLink)
	if err != nil {
		return err
	}
	return commitAt(dstDir, tmp, dstName)
}

// stageAt copies srcDir/srcName to dstDir/<dstName>.hsi-tmp and returns that name. A
// regular file is read from a descriptor opened O_NOFOLLOW and must have no other hard
// link; a symbolic link is copied as a link only when allowLink. Owner and mode (mode 0
// keeps the source's) are set on the temp file's descriptor.
func stageAt(srcDir *os.File, srcName string, dstDir *os.File, dstName string, mode os.FileMode, allowLink bool) (string, error) {
	st, err := statAt(srcDir, srcName)
	if err != nil {
		return "", err
	}
	tmp := dstName + ".hsi-tmp"
	if err := removeAt(dstDir, tmp); err != nil {
		return "", err
	}
	switch st.Mode & syscall.S_IFMT {
	case syscall.S_IFLNK:
		if !allowLink {
			return "", fmt.Errorf("%s is a symbolic link", srcName)
		}
		target, err := readlinkAt(srcDir, srcName)
		if err != nil {
			return "", err
		}
		if err := symlinkAt(target, dstDir, tmp); err != nil {
			return "", err
		}
		if err := syscall.Fchownat(int(dstDir.Fd()), tmp, int(st.Uid), int(st.Gid), atSymlinkNoFollow); err != nil {
			_ = removeAt(dstDir, tmp)
			return "", err
		}
	case syscall.S_IFREG:
		if err := copyRegularAt(srcDir, srcName, dstDir, tmp, mode); err != nil {
			_ = removeAt(dstDir, tmp)
			return "", err
		}
	default:
		return "", fmt.Errorf("%s is not a regular file", srcName)
	}
	return tmp, nil
}

// commitAt renames a staged dstDir/tmp over dstDir/name and syncs the directory.
func commitAt(dstDir *os.File, tmp, name string) error {
	if err := renameat(int(dstDir.Fd()), tmp, int(dstDir.Fd()), name); err != nil {
		_ = removeAt(dstDir, tmp)
		return err
	}
	return dstDir.Sync()
}

func copyRegularAt(srcDir *os.File, srcName string, dstDir *os.File, tmp string, mode os.FileMode) error {
	// O_NONBLOCK: a FIFO swapped in after the stat must not hang the open.
	fd, err := syscall.Openat(int(srcDir.Fd()), srcName, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("%s: %w", srcName, err)
	}
	in := os.NewFile(uintptr(fd), srcName)
	defer in.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return fmt.Errorf("%s is not a regular file", srcName)
	}
	if st.Nlink != 1 {
		return fmt.Errorf("%s has another hard link", srcName)
	}
	ofd, err := syscall.Openat(int(dstDir.Fd()), tmp, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return err
	}
	out := os.NewFile(uintptr(ofd), tmp)
	_, err = io.Copy(out, in)
	if err == nil {
		err = out.Chown(int(st.Uid), int(st.Gid))
	}
	if mode == 0 {
		mode = os.FileMode(st.Mode & 0o777)
	}
	if err == nil {
		err = out.Chmod(mode)
	}
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

// sysRenameat2 is the renameat2 syscall number, which package syscall does not name.
var sysRenameat2 = map[string]uintptr{"amd64": 316, "arm64": 276, "riscv64": 276, "loong64": 276, "386": 353, "arm": 382}[runtime.GOARCH]

const renameExchangeFlag = 0x2 // RENAME_EXCHANGE

// exchangeAt swaps dir/a and dir/b in one step (renameat2 RENAME_EXCHANGE): each
// name always leads to one of the two entries.
func exchangeAt(dir *os.File, a, b string) error {
	if sysRenameat2 == 0 {
		return syscall.ENOSYS
	}
	pa, err := syscall.BytePtrFromString(a)
	if err != nil {
		return err
	}
	pb, err := syscall.BytePtrFromString(b)
	if err != nil {
		return err
	}
	if _, _, e := syscall.Syscall6(sysRenameat2, dir.Fd(), uintptr(unsafe.Pointer(pa)), dir.Fd(), uintptr(unsafe.Pointer(pb)), renameExchangeFlag, 0); e != 0 {
		return e
	}
	return nil
}
