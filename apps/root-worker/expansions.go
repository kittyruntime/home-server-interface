package main

import (
	"encoding/json"
	"fmt"
	"os"
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
	lock, err := os.OpenFile(expansionsLockPath(), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return
	}
	defer lock.Close()
	if flockExclusive(lock) != nil {
		return // another finisher is at work
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)

	list := loadExpansions()
	changed := false
	for i := range list {
		e := &list[i]
		if e.Phase != "reshape" || e.Array == "" || hostSyncAction(e.Array) != "idle" {
			continue
		}
		if err := finishOne(*e); err != nil {
			e.Phase, e.Error = "failed", err.Error()
			logger.Warn("expansion failed", "volume", e.LV, "error", e.Error)
		} else {
			e.Phase, e.Error, e.NewSize = "done", "", hostLVSize(e.LV)
			logger.Info("expansion done", "volume", e.LV, "size", e.NewSize)
		}
		changed = true
	}
	if changed {
		if err := saveExpansions(list); err != nil {
			logger.Error("expansions: could not save", "error", err.Error())
		}
	}
}

// finishOne runs the end of one expansion. Each step is idempotent: a retry
// after a failure runs them all again.
func finishOne(e pendingExpansion) error {
	steps := []planStep{cmdStep("/dev/"+e.Array, "Let LVM use the new size of /dev/"+e.Array, []string{"pvresize", "/dev/" + e.Array})}
	run := func(ss []planStep) error {
		for _, s := range ss {
			if _, err := s.run(); err != nil {
				return fmt.Errorf("%s: %v", s.Summary, err)
			}
		}
		return nil
	}
	if err := run(steps); err != nil {
		return err
	}
	// lvextend refuses to grow by nothing: skip it when a retry already did.
	if hostVgFree(e.VG) > 0 {
		if err := run([]planStep{cmdStep(e.LV, "Give "+e.LV+" the new space", []string{"lvextend", "-l", "+100%FREE", e.LV})}); err != nil {
			return err
		}
	}
	mp := mountPointOf(hostProcMounts(), e.LV)
	if mp == "" && e.MountPoint != "" && strings.Contains(hostProcMounts(), " "+e.MountPoint+" ") {
		mp = e.MountPoint
	}
	grow, fe := growFsSteps(e.FSType, e.LV, mp, mp != "")
	if fe != nil {
		return fmt.Errorf("%s", fe.Message)
	}
	return run(grow)
}

func retryExpansion(uuid string) error {
	list := loadExpansions()
	for i := range list {
		if list[i].UUID == uuid && list[i].Phase == "failed" {
			list[i].Phase, list[i].Error = "reshape", ""
			return saveExpansions(list)
		}
	}
	return fmt.Errorf("no failed expansion for this volume")
}

// ackExpansion forgets a finished expansion once the backend announced it.
func ackExpansion(uuid string) error {
	list := loadExpansions()
	out := list[:0]
	for _, e := range list {
		if !(e.UUID == uuid && e.Phase == "done") {
			out = append(out, e)
		}
	}
	return saveExpansions(out)
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
