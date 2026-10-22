package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// ── Safe updates (#9a): rollback and recovery ────────────────────────────────

// rollback stops the stack, points current back to the snapshot's From, restores the
// database and the configuration, starts the stack and checks From's health. It runs
// once: a failure is recorded as rollback-failed, never retried. last.json is written
// and the in-progress marker cleared before it returns.
func rollback(snapshotDir, step, reason string) error {
	m, err := readManifest(snapshotDir)
	if err != nil {
		r := lastResult{Status: "rollback-failed", Step: step,
			Reason: fmt.Sprintf("%s; the rollback failed: %v (snapshot %s)", reason, err, snapshotDir)}
		if p, _ := readInProgress(); p != nil {
			r.From, r.To = p.From, p.To
		}
		_ = writeLast(r)
		clearInProgress()
		return err
	}
	logger.Warn("update: rolling back", "from", m.To, "to", m.From, "step", step, "reason", reason)
	target := unitPrefix() + ".target"
	var failed []string
	if out, err := systemctl("stop", target); err != nil {
		failed = append(failed, "stop "+target+": "+cmdErrMessage(out, err))
	}
	if err := switchCurrent(m.From); err != nil {
		failed = append(failed, err.Error())
	}
	if err := restoreDatabase(snapshotDir, m); err != nil {
		failed = append(failed, "restore the database: "+err.Error())
	}
	if err := restoreFiles(snapshotDir, m); err != nil {
		failed = append(failed, err.Error())
	}
	if out, err := systemctl("daemon-reload"); err != nil {
		failed = append(failed, "daemon-reload: "+cmdErrMessage(out, err))
	}
	if out, err := systemctl("start", target); err != nil {
		failed = append(failed, "start "+target+": "+cmdErrMessage(out, err))
	}
	if len(failed) == 0 {
		if err := waitHealthy(healthTargetFor(m.From)); err != nil {
			failed = append(failed, err.Error())
		}
	}
	r := lastResult{From: m.From, To: m.To, Status: "rolled-back", Step: step, Reason: reason}
	var result error
	if len(failed) > 0 {
		result = errors.New(strings.Join(failed, "; "))
		r.Status = "rollback-failed"
		r.Reason = fmt.Sprintf("%s; the rollback failed: %v (snapshot %s)", reason, result, snapshotDir)
		logger.Error("update: rollback failed", "snapshot", snapshotDir, "error", result.Error())
	}
	if err := writeLast(r); err != nil && result == nil {
		result = err
	}
	clearInProgress()
	return result
}

func restoreDatabase(dir string, m snapshotManifest) error {
	saved := snapshotPath(dir, m.Database)
	if _, err := os.Stat(saved); err != nil {
		return err
	}
	if err := copyPreserving(saved, m.DBTarget); err != nil {
		return err
	}
	// A journal of the version rolled back from would be replayed over the restored file.
	for _, ext := range []string{"-wal", "-shm", "-journal"} {
		if err := os.Remove(m.DBTarget + ext); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if _, err := os.Lstat(saved + "-wal"); err == nil {
		return copyPreserving(saved+"-wal", m.DBTarget+"-wal")
	}
	return nil
}

// restoreFiles puts back each snapshotted file with its mode, removes those that did
// not exist, and removes unit files of the prefix created since the snapshot.
func restoreFiles(dir string, m snapshotManifest) error {
	var failed []string
	listed := map[string]bool{}
	unitsListed := false
	for _, f := range m.Files {
		listed[f.Src] = true
		if filepath.Dir(f.Src) == systemdDir() {
			unitsListed = true
		}
		if !f.Existed {
			if err := os.Remove(f.Src); err != nil && !errors.Is(err, os.ErrNotExist) {
				failed = append(failed, err.Error())
			}
			continue
		}
		if err := restoreFile(snapshotPath(dir, f.Saved), f); err != nil {
			failed = append(failed, fmt.Sprintf("restore %s: %v", f.Src, err))
		}
	}
	// Only a snapshot that lists units knows which ones are new.
	if unitsListed {
		for _, u := range unitFiles() {
			if !listed[u] {
				if err := os.Remove(u); err != nil && !errors.Is(err, os.ErrNotExist) {
					failed = append(failed, err.Error())
				}
			}
		}
	}
	if len(failed) > 0 {
		return errors.New(strings.Join(failed, "; "))
	}
	return nil
}

func restoreFile(saved string, f snapFile) error {
	if err := os.MkdirAll(filepath.Dir(f.Src), 0o755); err != nil {
		return err
	}
	if err := copyPreserving(saved, f.Src); err != nil {
		return err
	}
	st, err := os.Lstat(f.Src)
	if err != nil || st.Mode()&os.ModeSymlink != 0 {
		return err
	}
	return os.Chmod(f.Src, os.FileMode(f.Mode).Perm())
}

// pidAlive tells whether a process with this pid exists.
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// recoverInterrupted runs at worker start: an update whose marker is still there,
// whose installer is gone and whose lock nobody holds was interrupted (killed,
// power cut) and is rolled back. The rollback stops the stack the worker belongs
// to, so it runs outside the worker's unit (startRecovery).
func recoverInterrupted() {
	p, err := readInProgress()
	if err != nil {
		logger.Error("update: the in-progress marker is unreadable", "error", err.Error())
		return
	}
	if p == nil {
		return
	}
	lock, free, err := tryUpdateLock()
	if err != nil || !free {
		return // the installer is running
	}
	lock.Close()
	if pidAlive(p.PID) {
		return
	}
	logger.Warn("update: an interrupted update is rolled back", "from", p.From, "to", p.To, "step", p.Step)
	if err := startRecovery(); err != nil {
		logger.Error("update: could not start the recovery", "error", err.Error())
	}
}

// startRecovery runs `hsi-worker update recover` as a transient unit, so stopping
// the stack does not kill it. systemd refuses a second unit of the same name.
var startRecovery = func() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	// The worker's settings come from its env file, never from --setenv: a transient
	// unit's environment is readable by any user (systemctl show), NATS_PASS included.
	args := []string{"--unit=" + unitPrefix() + "-update-recover", "--collect", "--quiet",
		"--property=EnvironmentFile=-" + workerEnvPath(), exe, "update", "recover"}
	if out, err := command("systemd-run", args...).CombinedOutput(); err != nil {
		return fmt.Errorf("systemd-run: %s", cmdErrMessage(out, err))
	}
	return nil
}

// recoverUpdate is the recovery itself, holding the update lock. A marker already at
// step "recovering" means a recovery was interrupted too: it is reported, not retried.
func recoverUpdate() error {
	lock, free, err := tryUpdateLock()
	if err != nil {
		return err
	}
	if !free {
		return nil
	}
	defer lock.Close()
	p, err := readInProgress()
	if err != nil || p == nil {
		return err
	}
	if pidAlive(p.PID) {
		return nil
	}
	if p.Step == "recovering" {
		reason := fmt.Sprintf("the recovery of an interrupted update was interrupted too; run 'sudo %s-worker update rollback --snapshot %s'", unitPrefix(), p.Snapshot)
		_ = writeLast(lastResult{From: p.From, To: p.To, Status: "rollback-failed", Step: "recovering", Reason: reason})
		clearInProgress()
		return errors.New(reason)
	}
	step := p.Step
	p.Step = "recovering"
	if err := writeInProgress(*p); err != nil {
		return err
	}
	return rollback(p.Snapshot, step, "interrupted")
}

// latestSnapshotFor returns the newest snapshot whose To is version.
func latestSnapshotFor(version string) (updateSnapshot, bool) {
	for _, s := range listSnapshots() {
		if s.Manifest.To == version {
			return s, true
		}
	}
	return updateSnapshot{}, false
}

// snapshotAge is how a manual rollback describes the database it brings back.
func snapshotAge(created time.Time) string {
	return created.Local().Format("2006-01-02 15:04")
}
