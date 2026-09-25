package main

import (
	"fmt"
	"os"
	"os/user"
	"strconv"
	"syscall"
)

// A new filesystem's root directory is root:root 0755, so nobody but root can
// write to a freshly mounted volume from the file manager or over SMB (both act
// as the connecting user). "shared" access makes the root owned by the user
// who mounted it and by the hsi-share group, setgid so new content keeps the
// group, matching how share directories are prepared.

// isFreshVolumeRoot reports whether a mount point's entries are those of a
// freshly created filesystem (nothing, or only ext4's lost+found).
func isFreshVolumeRoot(entries []string) bool {
	for _, name := range entries {
		if name != "lost+found" {
			return false
		}
	}
	return true
}

// prepareSharedVolumeRoot sets up shared access on a freshly formatted volume.
// It never touches a volume that already holds data or already has a non-root
// owner, and it only changes the mount point itself, never recursively.
// Returns warnings describing what was left unchanged.
func prepareSharedVolumeRoot(mountPoint, ownerUser string) []string {
	st, err := os.Stat(mountPoint)
	if err != nil {
		return []string{"could not inspect " + mountPoint + ": " + err.Error()}
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && sys.Uid != 0 {
		return []string{mountPoint + " already has an owner; permissions left unchanged"}
	}
	entries, err := os.ReadDir(mountPoint)
	if err != nil {
		return []string{"could not list " + mountPoint + ": " + err.Error()}
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if !isFreshVolumeRoot(names) {
		return []string{mountPoint + " already contains data; permissions left unchanged"}
	}

	if err := ensureShareGroup(); err != nil {
		return []string{"could not create the " + shareGroup + " group: " + err.Error()}
	}
	grp, err := user.LookupGroup(shareGroup)
	if err != nil {
		return []string{"could not find the " + shareGroup + " group: " + err.Error()}
	}
	gid, _ := strconv.Atoi(grp.Gid)

	var warnings []string
	uid := 0
	if ownerUser != "" {
		if u, err := user.Lookup(ownerUser); err == nil {
			uid, _ = strconv.Atoi(u.Uid)
		} else {
			warnings = append(warnings, fmt.Sprintf("Linux account %q not found; %s stays owned by root", ownerUser, mountPoint))
		}
	}
	if err := os.Chown(mountPoint, uid, gid); err != nil {
		return append(warnings, "could not set the owner of "+mountPoint+": "+err.Error())
	}
	if err := os.Chmod(mountPoint, 0o775|os.ModeSetgid); err != nil {
		return append(warnings, "could not set the permissions of "+mountPoint+": "+err.Error())
	}
	return warnings
}
