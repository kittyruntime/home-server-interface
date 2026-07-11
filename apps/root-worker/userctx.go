package main

import (
	"fmt"
	"os/user"
	"runtime"
	"strconv"
	"syscall"
)

type userCtx struct {
	uid  uint32
	gid  uint32
	gids []int
}

// resolveUser looks up uid, primary gid, and supplementary gids for a Linux username.
func resolveUser(username string) (userCtx, error) {
	u, err := user.Lookup(username)
	if err != nil {
		return userCtx{}, fmt.Errorf("user %q: %w", username, err)
	}
	// ParseUint with bitSize 32 bounds the result to uint32, so the casts below
	// cannot overflow (uid/gid are always small positive system IDs anyway).
	uid, err := strconv.ParseUint(u.Uid, 10, 32)
	if err != nil {
		return userCtx{}, fmt.Errorf("uid parse: %w", err)
	}
	gid, err := strconv.ParseUint(u.Gid, 10, 32)
	if err != nil {
		return userCtx{}, fmt.Errorf("gid parse: %w", err)
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
	return userCtx{uid: uint32(uid), gid: uint32(gid), gids: gids}, nil
}

// runAsUser executes fn with the effective uid/gid of the given user context.
//
// Implementation notes:
//   - LockOSThread pins the goroutine to a single OS thread so that uid/gid
//     changes (which are per-thread on Linux) do not bleed into other goroutines.
//   - We intentionally do NOT call UnlockOSThread: when the goroutine exits the
//     runtime destroys the OS thread, preventing any credential leak.
//   - Order: set supplementary groups and gid first (while still root), then
//     drop to effective uid. Restore in reverse order.
func runAsUser(ctx userCtx, fn func() error) error {
	ch := make(chan error, 1)
	go func() {
		runtime.LockOSThread()

		// 1. Supplementary groups (requires CAP_SETGID, still root here).
		if err := syscall.Setgroups(ctx.gids); err != nil {
			ch <- fmt.Errorf("setgroups: %w", err)
			return
		}
		// 2. Primary gid (keep saved gid = 0 to allow restore).
		if err := syscall.Setresgid(int(ctx.gid), int(ctx.gid), 0); err != nil {
			ch <- fmt.Errorf("setresgid: %w", err)
			return
		}
		// 3. Effective uid — drop root (keep real uid = 0, saved uid = 0).
		if err := syscall.Setresuid(0, int(ctx.uid), 0); err != nil {
			ch <- fmt.Errorf("setresuid: %w", err)
			return
		}

		err := fn()

		// Restore: uid first (saved uid = 0 allows this without CAP_SETUID).
		_ = syscall.Setresuid(0, 0, 0)
		// Then gid (now euid = 0, CAP_SETGID restored).
		_ = syscall.Setresgid(0, 0, 0)
		_ = syscall.Setgroups([]int{0})

		ch <- err
	}()
	return <-ch
}
