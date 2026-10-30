package main

import (
	"fmt"
	"math"
	"os/user"
	"runtime"
	"strconv"

	"golang.org/x/sys/unix"
)

type userCtx struct {
	uid  int
	gid  int
	gids []int
}

// resolveUser looks up uid, primary gid, and supplementary gids for a Linux username.
func resolveUser(username string) (userCtx, error) {
	u, err := user.Lookup(username)
	if err != nil {
		return userCtx{}, fmt.Errorf("user %q: %w", username, err)
	}
	// IDs above MaxInt32 are refused so they fit an int on every platform
	// (uid/gid are always small positive system IDs anyway).
	uid, err := strconv.ParseUint(u.Uid, 10, 32)
	if err != nil {
		return userCtx{}, fmt.Errorf("uid parse: %w", err)
	}
	gid, err := strconv.ParseUint(u.Gid, 10, 32)
	if err != nil {
		return userCtx{}, fmt.Errorf("gid parse: %w", err)
	}
	if uid > math.MaxInt32 || gid > math.MaxInt32 {
		return userCtx{}, fmt.Errorf("user %q: uid or gid out of range", username)
	}
	groupIDs, err := u.GroupIds()
	if err != nil {
		return userCtx{}, fmt.Errorf("groups: %w", err)
	}
	gids := make([]int, 0, len(groupIDs))
	for _, g := range groupIDs {
		n, err := strconv.Atoi(g)
		if err == nil {
			gids = append(gids, n)
		}
	}
	return userCtx{uid: int(uid), gid: int(gid), gids: gids}, nil
}

// runAsUser executes fn with the effective uid/gid of the given user context.
//
// Implementation notes:
//   - Credentials are changed with raw per-thread syscalls. The syscall
//     package's Setresuid/Setresgid/Setgroups (and x/sys/unix's Setresuid)
//     apply to every thread of the process since Go 1.16, which would leak
//     the user's identity into concurrent handlers running as root.
//   - LockOSThread pins the goroutine to the thread whose credentials change.
//   - We intentionally do NOT call UnlockOSThread: when the goroutine exits the
//     runtime destroys the OS thread, preventing any credential leak.
//   - Order: set supplementary groups and gid first (while still root), then
//     drop to effective uid. Restore in reverse order.
func runAsUser(ctx userCtx, fn func() error) error {
	ch := make(chan error, 1)
	go func() {
		runtime.LockOSThread()

		// 1. Supplementary groups (requires CAP_SETGID, still root here).
		if err := unix.Setgroups(ctx.gids); err != nil {
			ch <- fmt.Errorf("setgroups: %w", err)
			return
		}
		// 2. Primary gid (keep saved gid = 0 to allow restore).
		if err := threadSetresgid(ctx.gid, ctx.gid, 0); err != nil {
			ch <- fmt.Errorf("setresgid: %w", err)
			return
		}
		// 3. Effective uid: drop root (keep real uid = 0, saved uid = 0).
		if err := threadSetresuid(0, ctx.uid, 0); err != nil {
			ch <- fmt.Errorf("setresuid: %w", err)
			return
		}

		err := fn()

		// Restore: uid first (saved uid = 0 allows this without CAP_SETUID).
		_ = threadSetresuid(0, 0, 0)
		// Then gid (now euid = 0, CAP_SETGID restored).
		_ = threadSetresgid(0, 0, 0)
		_ = unix.Setgroups([]int{0})

		ch <- err
	}()
	return <-ch
}

// threadSetresuid changes the calling thread's uids only.
func threadSetresuid(ruid, euid, suid int) error {
	if _, _, e := unix.RawSyscall(unix.SYS_SETRESUID, uintptr(ruid), uintptr(euid), uintptr(suid)); e != 0 {
		return e
	}
	return nil
}

// threadSetresgid changes the calling thread's gids only.
func threadSetresgid(rgid, egid, sgid int) error {
	if _, _, e := unix.RawSyscall(unix.SYS_SETRESGID, uintptr(rgid), uintptr(egid), uintptr(sgid)); e != 0 {
		return e
	}
	return nil
}
