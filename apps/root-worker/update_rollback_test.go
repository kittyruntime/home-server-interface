package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// preparedUpdate is a host snapshotted for v2.0.0 -> v2.1.0, then changed the way an
// update would: switched, db and env rewritten, a unit and a config file created.
func preparedUpdate(t *testing.T) (*updateEnv, string) {
	t.Helper()
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0", "v2.1.0")
	if err := switchCurrent("v2.0.0"); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, e.db, []byte("old db"))
	mustWrite(t, e.workerEnv, []byte("OLD=1\n"))
	if err := os.WriteFile(filepath.Join(e.systemd, "hsi-server.service"), []byte("old unit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir, err := takeSnapshot("v2.0.0", "v2.1.0", e.db, snapshotConfigFiles())
	if err != nil {
		t.Fatal(err)
	}
	if err := switchCurrent("v2.1.0"); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, e.db, []byte("new db"))
	mustWrite(t, e.db+"-wal", []byte("new wal"))
	mustWrite(t, e.workerEnv, []byte("NEW=1\n"))
	if err := os.Chmod(e.workerEnv, 0o644); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(e.systemd, "hsi-server.service"), []byte("new unit\n"))
	mustWrite(t, filepath.Join(e.systemd, "hsi-new.timer"), []byte("new timer\n"))
	mustWrite(t, e.natsConf, []byte("new nats\n"))
	if err := writeInProgress(inProgress{From: "v2.0.0", To: "v2.1.0", Snapshot: dir, Step: "health", PID: deadPID(t)}); err != nil {
		t.Fatal(err)
	}
	return e, dir
}

func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("true")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	return cmd.Process.Pid
}

func TestRollbackRestoresEverything(t *testing.T) {
	e, dir := preparedUpdate(t)
	calls := fakeSystemctl(t)
	var checked string
	fakeHealth(t, nil, nil)
	prev := httpHealth
	httpHealth = func(tg healthTarget) error { checked = tg.Version; return prev(tg) }

	if err := rollback(dir, "health", "the health checks failed"); err != nil {
		t.Fatal(err)
	}
	if currentVersion() != "v2.0.0" {
		t.Fatalf("current %q", currentVersion())
	}
	if got := string(mustRead(t, e.db)); got != "old db" {
		t.Fatalf("db %q", got)
	}
	if _, err := os.Stat(e.db + "-wal"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a WAL file of the new version was left next to the restored database")
	}
	if got := string(mustRead(t, e.workerEnv)); got != "OLD=1\n" {
		t.Fatalf("worker.env %q", got)
	}
	if st, _ := os.Stat(e.workerEnv); st.Mode().Perm() != 0o600 {
		t.Fatalf("worker.env mode %v", st.Mode().Perm())
	}
	if got := string(mustRead(t, filepath.Join(e.systemd, "hsi-server.service"))); got != "old unit\n" {
		t.Fatalf("unit %q", got)
	}
	for _, gone := range []string{filepath.Join(e.systemd, "hsi-new.timer"), e.natsConf} {
		if _, err := os.Stat(gone); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s created by the update was kept", gone)
		}
	}
	if strings.Join(*calls, "|") != "stop hsi.target|daemon-reload|start hsi.target" {
		t.Fatalf("systemctl calls %v", *calls)
	}
	if checked != "v2.0.0" {
		t.Fatalf("health checked for %q, want the previous version", checked)
	}
	r, err := readLast()
	if err != nil || r == nil || r.Status != "rolled-back" || r.From != "v2.0.0" || r.To != "v2.1.0" || r.Step != "health" || r.Reason != "the health checks failed" {
		t.Fatalf("last %+v %v", r, err)
	}
	if p, _ := readInProgress(); p != nil {
		t.Fatal("marker kept after the rollback")
	}
}

func TestRollbackRunsOnceAndReportsFailure(t *testing.T) {
	_, dir := preparedUpdate(t)
	calls := fakeSystemctl(t)
	fakeHealth(t, nil, func() error { return errors.New("no responders") })

	err := rollback(dir, "health", "the health checks failed")
	if err == nil {
		t.Fatal("a rollback whose health check fails succeeded")
	}
	stops, starts := 0, 0
	for _, c := range *calls {
		if c == "stop hsi.target" {
			stops++
		}
		if c == "start hsi.target" {
			starts++
		}
	}
	if stops != 1 || starts != 1 {
		t.Fatalf("want one stop/start cycle, got %v", *calls)
	}
	r, _ := readLast()
	if r == nil || r.Status != "rollback-failed" || !strings.Contains(r.Reason, "worker") || !strings.Contains(r.Reason, dir) {
		t.Fatalf("last %+v", r)
	}
	if p, _ := readInProgress(); p != nil {
		t.Fatal("a failed rollback must not be retried: marker kept")
	}
}

func inProcessRecovery(t *testing.T) *int {
	t.Helper()
	n := 0
	prev := startRecovery
	startRecovery = func() error { n++; return recoverUpdate() }
	t.Cleanup(func() { startRecovery = prev })
	return &n
}

func TestRecoverInterrupted(t *testing.T) {
	t.Run("dead installer", func(t *testing.T) {
		_, _ = preparedUpdate(t)
		fakeSystemctl(t)
		fakeHealth(t, nil, nil)
		started := inProcessRecovery(t)
		recoverInterrupted()
		if *started != 1 {
			t.Fatalf("recovery started %d times", *started)
		}
		r, _ := readLast()
		if r == nil || r.Status != "rolled-back" || r.Reason != "interrupted" || r.Step != "health" {
			t.Fatalf("last %+v", r)
		}
		if currentVersion() != "v2.0.0" {
			t.Fatalf("current %q", currentVersion())
		}
		recoverInterrupted()
		if *started != 1 {
			t.Fatal("recovered twice")
		}
	})
	t.Run("installer holds the lock", func(t *testing.T) {
		e, _ := preparedUpdate(t)
		calls := fakeSystemctl(t)
		started := inProcessRecovery(t)
		lock, err := os.OpenFile(filepath.Join(e.state, "update.lock"), os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		defer lock.Close()
		if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			t.Fatal(err)
		}
		recoverInterrupted()
		if err := recoverUpdate(); err != nil {
			t.Fatal(err)
		}
		if *started != 0 || len(*calls) != 0 || currentVersion() != "v2.1.0" {
			t.Fatalf("touched a live update: started %d, calls %v, current %s", *started, *calls, currentVersion())
		}
		if r, _ := readLast(); r != nil {
			t.Fatalf("last written %+v", r)
		}
		if p, _ := readInProgress(); p == nil {
			t.Fatal("marker removed")
		}
	})
	t.Run("PID reused in the same boot", func(t *testing.T) {
		// The lock is the authority: free means the installer is gone, whatever runs
		// under its PID now.
		_, dir := preparedUpdate(t)
		fakeSystemctl(t)
		fakeHealth(t, nil, nil)
		started := inProcessRecovery(t)
		_ = writeInProgress(inProgress{From: "v2.0.0", To: "v2.1.0", Snapshot: dir, Step: "health", PID: os.Getpid(), Started: time.Now()})
		recoverInterrupted()
		if *started != 1 {
			t.Fatal("a live process with the marker's PID blocked the recovery")
		}
		if r, _ := readLast(); r == nil || r.Status != "rolled-back" {
			t.Fatalf("last %+v", r)
		}
	})
	t.Run("recovery itself interrupted", func(t *testing.T) {
		_, dir := preparedUpdate(t)
		calls := fakeSystemctl(t)
		inProcessRecovery(t)
		_ = writeInProgress(inProgress{From: "v2.0.0", To: "v2.1.0", Snapshot: dir, Step: "recovering", PID: deadPID(t)})
		recoverInterrupted()
		if len(*calls) != 0 {
			t.Fatalf("a recovery was retried: %v", *calls)
		}
		r, _ := readLast()
		if r == nil || r.Status != "rollback-failed" || !strings.Contains(r.Reason, dir) {
			t.Fatalf("last %+v", r)
		}
		if p, _ := readInProgress(); p != nil {
			t.Fatal("marker kept")
		}
	})
}
