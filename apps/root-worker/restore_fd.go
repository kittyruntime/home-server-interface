package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

// ── Restores into user-writable trees ────────────────────────────────────────
// A restore runs as root, while the volumes it writes to can be changed by their
// users. Checking a path and then using it leaves a gap in which a directory can
// be swapped for a symlink, so everything here works on directories held by file
// descriptor: a held directory stays the same inode whatever happens to its ancestors.

const (
	dirOpenFlags = syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
	atRemoveDir  = 0x200
	maxMergeWarn = 20
)

// restoreOwnerUID is the owner expected on the directories a restore creates: whoever runs it.
var restoreOwnerUID = os.Geteuid

func fdName(fd int) string { return "/proc/self/fd/" + strconv.Itoa(fd) }

// openatDir opens the directory name of parent, failing on a symlink or a file.
func openatDir(parent *os.File, name string) (*os.File, error) {
	fd, err := syscall.Openat(int(parent.Fd()), name, dirOpenFlags, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), fdName(fd)), nil
}

// notRealDir reports an open that failed because the entry is a symlink or a file.
func notRealDir(err error) bool {
	return errors.Is(err, syscall.ENOTDIR) || errors.Is(err, syscall.ELOOP)
}

// openDirNoFollow opens an absolute directory one component at a time from "/", so a
// symlink anywhere in the chain fails.
func openDirNoFollow(path string) (*os.File, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("%s is not an absolute path", path)
	}
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	cur := os.NewFile(uintptr(fd), "/")
	for _, comp := range strings.Split(filepath.Clean(path), "/") {
		if comp == "" {
			continue
		}
		next, err := openatDir(cur, comp)
		cur.Close()
		if err != nil {
			return nil, fmt.Errorf("%s is not a real directory (symbolic link or missing component): %w", path, err)
		}
		cur = next
	}
	return cur, nil
}

// checkOwnedDir fails unless f is a directory owned by the process; strict also refuses
// group and other write bits.
func checkOwnedDir(f *os.File, what string, strict bool) error {
	var st syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
		return err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFDIR || int(st.Uid) != restoreOwnerUID() {
		return fmt.Errorf("%s is not a directory owned by root, refusing to restore into it", what)
	}
	if strict && st.Mode&0o022 != 0 {
		return fmt.Errorf("%s is writable by other users, refusing to restore into it", what)
	}
	return nil
}

// openRestoredDir opens <base>/Restored, creating it when missing. An existing one must be
// owned by us and closed to other writers, or a user could redirect what is put inside.
func openRestoredDir(base *os.File) (*os.File, error) {
	if err := syscall.Mkdirat(int(base.Fd()), "Restored", 0o755); err != nil && !errors.Is(err, syscall.EEXIST) {
		return nil, err
	}
	f, err := openatDir(base, "Restored")
	if err != nil {
		return nil, fmt.Errorf("Restored is not a real directory: %w", err)
	}
	if err := checkOwnedDir(f, "Restored", true); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// afterMkdirHook runs between creating a directory and reopening it; tests use it to swap
// the entry the way an attacker would.
var afterMkdirHook func(parent *os.File, name string)

// checkFreshDir fails unless f is the directory we just made: ours, mode 0700, empty.
// S_ISGID is ignored: Linux sets it on every directory created under a setgid one, and
// share volumes are 2775. Any other extra bit means the entry is not ours.
func checkFreshDir(f *os.File, what string) error {
	var st syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
		return err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFDIR || int(st.Uid) != restoreOwnerUID() || st.Mode&0o7777&^syscall.S_ISGID != 0o700 {
		return fmt.Errorf("%s was replaced while it was being created, refusing to use it", what)
	}
	entries, err := readDirFd(f)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		return fmt.Errorf("%s was replaced while it was being created, refusing to use it", what)
	}
	return nil
}

// createFreshDir makes a directory that did not exist (mode 0700) and returns it held.
// With suffix, a taken name gets -2, -3, and so on; otherwise a taken name is an error.
// The entry is checked after it is reopened, in case it was swapped in between.
func createFreshDir(parent *os.File, name string, suffix bool) (*os.File, string, error) {
	for i := 1; i <= 1000; i++ {
		n := name
		if i > 1 {
			n = fmt.Sprintf("%s-%d", name, i)
		}
		err := syscall.Mkdirat(int(parent.Fd()), n, 0o700)
		if errors.Is(err, syscall.EEXIST) && suffix {
			continue
		}
		if err != nil {
			return nil, "", err
		}
		if afterMkdirHook != nil {
			afterMkdirHook(parent, n)
		}
		f, err := openatDir(parent, n)
		if err != nil {
			return nil, "", err
		}
		if err := checkFreshDir(f, n); err != nil {
			f.Close()
			return nil, "", err
		}
		return f, n, nil
	}
	return nil, "", fmt.Errorf("no free directory name for %s", name)
}

func unlinkat(parent *os.File, name string, flags uintptr) error {
	p, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	if _, _, e := syscall.Syscall(syscall.SYS_UNLINKAT, parent.Fd(), uintptr(unsafe.Pointer(p)), flags); e != 0 {
		return e
	}
	return nil
}

func readDirFd(dir *os.File) ([]os.DirEntry, error) {
	dup, err := openatDir(dir, ".")
	if err != nil {
		return nil, err
	}
	defer dup.Close()
	return dup.ReadDir(-1)
}

// removeChildren empties the held directory d through descriptors only, never following
// a symlink and never reopening anything by a name that someone else could change.
func removeChildren(d *os.File) error {
	_ = d.Chmod(0o700)
	entries, err := readDirFd(d)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !e.IsDir() {
			if err := unlinkat(d, e.Name(), 0); err != nil {
				return err
			}
			continue
		}
		child, err := openatDir(d, e.Name())
		if err != nil {
			return err
		}
		err = removeChildren(child)
		child.Close()
		if err != nil {
			return err
		}
		if err := unlinkat(d, e.Name(), atRemoveDir); err != nil {
			return err
		}
	}
	return nil
}

// descendDirs opens path's components below start, one by one, and returns the last as a
// new descriptor (a duplicate of start when path is "/"). The caller closes it.
func descendDirs(start *os.File, path string) (*os.File, error) {
	cur, err := openatDir(start, ".")
	if err != nil {
		return nil, err
	}
	for _, comp := range strings.Split(path, "/") {
		if comp == "" {
			continue
		}
		next, err := openatDir(cur, comp)
		cur.Close()
		if err != nil {
			return nil, err
		}
		cur = next
	}
	return cur, nil
}

type mergeResult struct {
	moved    int
	warnings []string
}

// renameat moves a staged entry into place; tests swap it.
var renameat = syscall.Renameat

// beforeRenameHook runs between the destination check and the rename; tests use it to change the destination.
var beforeRenameHook func(dst *os.File, name string)

func (m *mergeResult) warn(msg string) {
	if len(m.warnings) < maxMergeWarn {
		m.warnings = append(m.warnings, msg)
	} else if len(m.warnings) == maxMergeWarn {
		m.warnings = append(m.warnings, "more entries were skipped")
	}
}

// mergeInto moves the tree held by src into dst, relative to descriptors only. A file or
// symlink replaces the entry of the same name atomically (renameat never follows the
// final name). Directories that exist at the destination are entered, missing ones are
// created with the owner and mode of the staged one. What the snapshot does not hold is
// left alone, and a file/directory mismatch is skipped with a warning.
func mergeInto(src, dst *os.File, rel string, res *mergeResult) error {
	entries, err := readDirFd(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		name, relName := e.Name(), rel+"/"+e.Name()
		if e.IsDir() {
			child, err := openatDir(src, name)
			if err != nil {
				return err
			}
			created := false
			dchild, derr := openatDir(dst, name)
			if errors.Is(derr, syscall.ENOENT) {
				if merr := syscall.Mkdirat(int(dst.Fd()), name, 0o700); merr == nil {
					created = true
					if afterMkdirHook != nil {
						afterMkdirHook(dst, name)
					}
					dchild, derr = openatDir(dst, name)
					if derr == nil {
						// Reopened by name in a tree others can write: it must be the one just made.
						if cerr := checkFreshDir(dchild, relName); cerr != nil {
							dchild.Close()
							derr = cerr
						}
					}
				}
			}
			if created && derr != nil {
				// We made it, so a failure to reopen or check it means someone swapped it.
				res.warn(relName + " was replaced by another entry while it was being created, skipped")
				child.Close()
				continue
			}
			if derr != nil {
				res.warn(relName + " is not a directory at the destination, skipped")
				child.Close()
				continue
			}
			err = mergeInto(child, dchild, relName, res)
			if err == nil && created {
				var st syscall.Stat_t
				if err = syscall.Fstat(int(child.Fd()), &st); err == nil {
					if cerr := syscall.Fchown(int(dchild.Fd()), int(st.Uid), int(st.Gid)); cerr != nil && !errors.Is(cerr, syscall.EPERM) {
						err = cerr
					}
				}
				if err == nil {
					err = syscall.Fchmod(int(dchild.Fd()), st.Mode&0o7777)
				}
			}
			child.Close()
			dchild.Close()
			if err != nil {
				return err
			}
			continue
		}
		if d, derr := openatDir(dst, name); derr == nil {
			d.Close()
			res.warn(relName + " is a directory at the destination, skipped")
			continue
		} else if !errors.Is(derr, syscall.ENOENT) && !notRealDir(derr) {
			return derr
		}
		if beforeRenameHook != nil {
			beforeRenameHook(dst, name)
		}
		if err := renameat(int(src.Fd()), name, int(dst.Fd()), name); err != nil {
			if errors.Is(err, syscall.EISDIR) || errors.Is(err, syscall.ENOTDIR) {
				res.warn(relName + " changed type at the destination, skipped")
				continue
			}
			if errors.Is(err, syscall.EXDEV) {
				// Another filesystem is mounted inside the restored path.
				res.warn(relName + " is on another volume, skipped: restore it to a new folder")
				continue
			}
			return fmt.Errorf("%s: %w", relName, err)
		}
		res.moved++
	}
	return nil
}

// ── Local repositories ───────────────────────────────────────────────────────
// restic writes a local repository as root. A symbolic link on the way to it, or a
// folder other users can write to, would let them send those writes elsewhere.

// walkNoFollow opens path one component at a time from "/". With create, missing
// components are made (the last one 0700, owned by us); without, the walk stops at the
// first missing one and returns nil.
func walkNoFollow(path string, create bool) (*os.File, error) {
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	cur := os.NewFile(uintptr(fd), "/")
	comps := strings.Split(strings.TrimPrefix(filepath.Clean(path), "/"), "/")
	for i, comp := range comps {
		next, err := openatDir(cur, comp)
		if errors.Is(err, syscall.ENOENT) && create {
			mode := uint32(0o755)
			if i == len(comps)-1 {
				mode = 0o700
			}
			if merr := syscall.Mkdirat(int(cur.Fd()), comp, mode); merr != nil && !errors.Is(merr, syscall.EEXIST) {
				cur.Close()
				return nil, fmt.Errorf("create %s: %w", path, merr)
			}
			next, err = openatDir(cur, comp)
		}
		cur.Close()
		if errors.Is(err, syscall.ENOENT) && !create {
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("the repository folder %s goes through a symbolic link or a file", path)
		}
		cur = next
	}
	return cur, nil
}

// checkLocalRepoPath refuses a repository path with a symbolic link or a file in it,
// and an existing folder that is not root's alone. The folder may not exist yet.
func checkLocalRepoPath(path string) error {
	f, err := walkNoFollow(path, false)
	if err != nil || f == nil {
		return err
	}
	defer f.Close()
	return checkRepoDirFd(f, path)
}

func checkRepoDirFd(f *os.File, path string) error {
	var st syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
		return err
	}
	if int(st.Uid) != restoreOwnerUID() || st.Mode&0o022 != 0 {
		return fmt.Errorf("the repository folder %s must be owned by root and closed to other users", path)
	}
	return nil
}

// ensureLocalRepoDir creates the repository folder (0700) when it is missing, then
// checks it as checkLocalRepoDir does.
func ensureLocalRepoDir(path string) error {
	f, err := walkNoFollow(path, true)
	if err != nil {
		return err
	}
	defer f.Close()
	return checkRepoDirFd(f, path)
}

// checkLocalRepoDir fails unless path is a real directory reached without a symbolic
// link, owned by root and not writable by other users.
func checkLocalRepoDir(path string) error {
	f, err := walkNoFollow(path, false)
	if err != nil {
		return err
	}
	if f == nil {
		return fmt.Errorf("the repository folder %s does not exist", path)
	}
	defer f.Close()
	return checkRepoDirFd(f, path)
}

// repositoryReady is checked before restic opens a repository: a local one must still
// be a safe folder.
func repositoryReady(r repositoryCfg) error {
	if r.Type != "local" {
		return nil
	}
	return checkLocalRepoDir(r.Path)
}
