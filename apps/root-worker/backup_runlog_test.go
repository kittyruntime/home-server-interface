package main

import (
	"errors"
	"testing"
	"time"
)

func TestRunLogCapsAndOrders(t *testing.T) {
	useBackupDirs(t)
	base := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 205; i++ {
		_ = appendRun("runs", planA, runRecord{Start: base.Add(time.Duration(i) * time.Minute), Status: "success"})
	}
	all, _ := lastRuns("runs", planA, 500)
	if len(all) != 200 || !all[0].Start.Equal(base.Add(204*time.Minute)) {
		t.Fatalf("len %d first %v", len(all), all[0].Start)
	}
}

func TestLockIsExclusive(t *testing.T) {
	useBackupDirs(t)
	lockWait = 50 * time.Millisecond
	t.Cleanup(func() { lockWait = 10 * time.Minute })
	inner := make(chan error, 1)
	_ = withLock(repoA, lockWait, func() error {
		inner <- withLock(repoA, lockWait, func() error { return nil })
		return nil
	})
	if err := <-inner; !errors.Is(err, errBackupBusy) {
		t.Fatalf("got %v", err)
	}
}

func TestProgressRoundTrip(t *testing.T) {
	useBackupDirs(t)
	if _, ok := readProgress(planA); ok {
		t.Fatal("progress before any run")
	}
	if err := writeProgress(planA, backupProgress{PercentDone: 0.5, FilesDone: 3}); err != nil {
		t.Fatal(err)
	}
	p, ok := readProgress(planA)
	if !ok || p.FilesDone != 3 {
		t.Fatalf("%+v %v", p, ok)
	}
	clearProgress(planA)
	if _, ok := readProgress(planA); ok {
		t.Fatal("progress not cleared")
	}
}
