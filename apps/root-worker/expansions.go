package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	nats "github.com/nats-io/nats.go"
)

// Finishing expansions (#7): once an array's reshape or resync is over, the
// volume on it takes the new space: pvresize, lvextend, filesystem growth.
// Run every minute by the worker and hourly by `hsi-worker maintenance`, so it
// happens even when one of them is down; a lock keeps them from overlapping.

var hostLVSize = func(lv string) int64 {
	out, _ := hostOutput("lvs", "--noheadings", "--nosuffix", "--units", "b", "-o", "lv_size", lv)
	n, _ := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	return n
}

func expansionsLockPath() string { return envOr("HSI_EXPANSIONS_LOCK", "/run/hsi-expansions.lock") }

func flockExclusive(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}

func finishExpansions(now time.Time) {
	// One finisher at a time (the daemon tick, the hourly run, a retry); the
	// file itself is only written through updateExpansions.
	lock, err := os.OpenFile(expansionsLockPath(), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return
	}
	defer lock.Close()
	if flockExclusive(lock) != nil {
		return
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	for _, e := range loadExpansions() {
		if e.Phase != "reshape" {
			continue
		}
		array := e.Array
		if e.ArrayUUID != "" {
			if name := hostArrayByUUID(e.ArrayUUID); name != "" {
				array = name
			}
		}
		// Ready: idle, and larger than before (an array that came back after
		// a reboot reads idle until its reshape resumes).
		if array == "" || hostSyncAction(array) != "idle" || (e.OldSize > 0 && hostArraySize(array) <= e.OldSize) {
			continue
		}
		e.Array = array
		ferr := finishOne(e)
		_ = updateExpansions(func(list []pendingExpansion) []pendingExpansion {
			for i := range list {
				if list[i].UUID != e.UUID || list[i].Phase != "reshape" {
					continue
				}
				list[i].Array = array
				if ferr != nil {
					list[i].Phase, list[i].Error = "failed", ferr.Error()
				} else {
					list[i].Phase, list[i].Error, list[i].NewSize, list[i].FinishedAt = "done", "", hostLVSize(e.LV), now
				}
			}
			return list
		})
		if ferr != nil {
			logger.Warn("expansion failed", "volume", e.LV, "error", ferr.Error())
		} else {
			logger.Info("expansion done", "volume", e.LV)
		}
	}
	// Announced expansions are kept a day, so their alert clears, then dropped.
	_ = updateExpansions(func(list []pendingExpansion) []pendingExpansion {
		out := list[:0]
		for _, e := range list {
			if !(e.Phase == "done" && e.Announced && now.Sub(e.FinishedAt) > 24*time.Hour) {
				out = append(out, e)
			}
		}
		return out
	})
}

// finishOne runs the end of one expansion. Each step is idempotent: a retry
// after a failure runs them all again.
func finishOne(e pendingExpansion) error {
	run := func(ss []planStep) error {
		for _, s := range ss {
			if _, err := s.run(); err != nil {
				return fmt.Errorf("%s: %v", s.Summary, err)
			}
		}
		return nil
	}
	if err := run([]planStep{cmdStep("/dev/"+e.Array, "Let LVM use the new size of /dev/"+e.Array, []string{"pvresize", "/dev/" + e.Array})}); err != nil {
		return err
	}
	// lvextend refuses to grow by nothing: skip it when a retry already did.
	if hostVgFree(e.VG) > 0 {
		if err := run([]planStep{cmdStep(e.LV, "Give "+e.LV+" the new space", []string{"lvextend", "-l", "+100%FREE", e.LV})}); err != nil {
			return err
		}
	}
	// Mounted now? /proc/mounts names the LV by its device-mapper node.
	mp := mountPointOf(hostProcMounts(), e.LV, lvDmPath(e.VG, filepath.Base(e.LV)))
	grow, fe := growFsSteps(e.FSType, e.LV, mp, mp != "")
	if fe != nil {
		return fmt.Errorf("%s", fe.Message)
	}
	return run(grow)
}

func retryExpansion(uuid string) error {
	found := false
	err := updateExpansions(func(list []pendingExpansion) []pendingExpansion {
		for i := range list {
			if list[i].UUID == uuid && list[i].Phase == "failed" {
				list[i].Phase, list[i].Error = "reshape", ""
				found = true
			}
		}
		return list
	})
	if err == nil && !found {
		return fmt.Errorf("no failed expansion for this volume")
	}
	return err
}

// ackExpansion marks a finished expansion as announced by the backend.
func ackExpansion(uuid string) error {
	return updateExpansions(func(list []pendingExpansion) []pendingExpansion {
		for i := range list {
			if list[i].UUID == uuid && list[i].Phase == "done" {
				list[i].Announced = true
			}
		}
		return list
	})
}

func handleExpansions(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, map[string]any{"expansions": loadExpansions()})
}

func handleExpansionRetry(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		UUID string `json:"uuid"`
	}
	_ = json.Unmarshal(msg.Data, &req)
	if err := retryExpansion(req.UUID); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	go finishExpansions(time.Now())
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

func handleExpansionAck(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		UUID string `json:"uuid"`
	}
	_ = json.Unmarshal(msg.Data, &req)
	if err := ackExpansion(req.UUID); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}
