package main

import (
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
)

// A bare "permission denied" does not say why. File operations run as the
// HSI user's Linux account, so the useful context is that account and the
// owner/mode of the directory it tried to write to.

// permissionTargetDir picks the directory a failed file task needed access to.
func permissionTargetDir(task taskMsg) string {
	switch {
	case task.ParentPath != "":
		return task.ParentPath
	case task.DstDir != "":
		return task.DstDir
	case task.Path != "":
		return filepath.Dir(task.Path)
	}
	return ""
}

func formatPermissionContext(dir, linuxUser, owner, group string, mode os.FileMode) string {
	who := "root"
	if linuxUser != "" {
		who = fmt.Sprintf("%q", linuxUser)
	}
	return fmt.Sprintf(" (ran as %s; %s is owned by %s:%s with mode %04o)", who, dir, owner, group, octalMode(mode))
}

// octalMode renders permission bits the way chmod takes them, e.g. 2775.
func octalMode(mode os.FileMode) uint32 {
	bits := uint32(mode.Perm())
	if mode&os.ModeSetuid != 0 {
		bits |= 0o4000
	}
	if mode&os.ModeSetgid != 0 {
		bits |= 0o2000
	}
	if mode&os.ModeSticky != 0 {
		bits |= 0o1000
	}
	return bits
}

func permissionContext(dir, linuxUser string) string {
	if dir == "" {
		return ""
	}
	st, err := os.Stat(dir)
	if err != nil {
		return ""
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}
	owner := strconv.FormatUint(uint64(sys.Uid), 10)
	if u, err := user.LookupId(owner); err == nil {
		owner = u.Username
	}
	group := strconv.FormatUint(uint64(sys.Gid), 10)
	if g, err := user.LookupGroupId(group); err == nil {
		group = g.Name
	}
	return formatPermissionContext(dir, linuxUser, owner, group, st.Mode())
}
