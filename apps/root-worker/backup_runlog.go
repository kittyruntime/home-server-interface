package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

const maxRunLines = 200

type runRecord struct {
	RunID      string     `json:"runId,omitempty"` // restores only
	Start      time.Time  `json:"start"`
	End        *time.Time `json:"end,omitempty"`
	Status     string     `json:"status"` // running | success | failed
	SnapshotID string     `json:"snapshotId,omitempty"`
	Consistent *bool      `json:"consistent,omitempty"`
	Added      int64      `json:"added,omitempty"`
	Files      int        `json:"files,omitempty"`
	Error      string     `json:"error,omitempty"`
	Warnings   []string   `json:"warnings,omitempty"`
	Target     string     `json:"target,omitempty"` // restores only: the folder written, or the restored path
}

var errBackupBusy = errors.New("the repository is busy with another backup, check or restore")

var errRunActive = errors.New("this run is already in progress")

var lockWait = 10 * time.Minute

func backupLocksDir() string {
	return envOr("HSI_BACKUP_LOCKS", "/run/hsi/backup")
}

// tryLock takes an exclusive flock on <locks>/<name> within wait. It returns the open
// file (closing it releases the lock), errWait when the wait ends first, or
// errInterrupted when the run is interrupted meanwhile.
func tryLock(name string, wait time.Duration, errWait error) (*os.File, error) {
	if err := os.MkdirAll(backupLocksDir(), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(backupLocksDir(), name), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(wait)
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return f, nil
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EINTR {
			f.Close()
			return nil, err
		}
		if interrupted.Load() {
			f.Close()
			return nil, errInterrupted
		}
		if !time.Now().Before(deadline) {
			f.Close()
			return nil, errWait
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// withLock runs fn holding the repository lock <locks>/<key>.lock, waiting up to wait.
func withLock(key string, wait time.Duration, fn func() error) error {
	f, err := tryLock(key+".lock", wait, errBackupBusy)
	if err != nil {
		return err
	}
	defer f.Close()
	return fn()
}

// runLockWait covers a status probe that holds the run lock for an instant.
var runLockWait = 5 * time.Second

// holdRunLock marks the run id (a plan, repository or restore run) as in progress for as
// long as the process holds it: from before the run waits for its repository until its
// record is written. A lock dies with its process, so a crash or a reboot never leaves
// a run "running".
func holdRunLock(id string) (release func(), err error) {
	f, err := tryLock(id+".run", runLockWait, errRunActive)
	if err != nil {
		return nil, err
	}
	return func() { f.Close() }, nil
}

// lockHeld tells whether a process holds <locks>/<name>, without waiting.
func lockHeld(name string) bool {
	f, err := os.Open(filepath.Join(backupLocksDir(), name))
	if err != nil {
		return false
	}
	defer f.Close()
	err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if err == nil {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		return false
	}
	return err == syscall.EWOULDBLOCK
}

// runActive tells whether the run id is in progress.
func runActive(id string) bool { return lockHeld(id + ".run") }

// repositoryBusy tells whether a backup, check or restore holds the repository.
func repositoryBusy(id string) bool { return lockHeld(id + ".lock") }

func runLogPath(kind, id string) string {
	return filepath.Join(backupStateDir(), kind, id+".jsonl")
}

// appendRun adds a record to the log of a plan or repository, keeping the last 200 lines.
func appendRun(kind, id string, r runRecord) error {
	path := runLogPath(kind, id)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	line, err := json.Marshal(r)
	if err != nil {
		return err
	}
	lines := bytes.Split(bytes.TrimRight(raw, "\n"), []byte("\n"))
	if len(raw) == 0 {
		lines = nil
	}
	lines = append(lines, line)
	if len(lines) > maxRunLines {
		lines = lines[len(lines)-maxRunLines:]
	}
	return writeBackupFile(path, append(bytes.Join(lines, []byte("\n")), '\n'), 0o644)
}

// lastRuns returns up to n records, newest first. Unreadable lines are skipped.
func lastRuns(kind, id string, n int) ([]runRecord, error) {
	raw, err := os.ReadFile(runLogPath(kind, id))
	if errors.Is(err, os.ErrNotExist) {
		return []runRecord{}, nil
	}
	if err != nil {
		return nil, err
	}
	lines := bytes.Split(bytes.TrimRight(raw, "\n"), []byte("\n"))
	out := []runRecord{}
	for i := len(lines) - 1; i >= 0 && len(out) < n; i-- {
		var r runRecord
		if json.Unmarshal(lines[i], &r) == nil {
			out = append(out, r)
		}
	}
	return out, nil
}

func progressPath(id string) string {
	return filepath.Join(backupStateDir(), "progress", id+".json")
}

func writeProgress(id string, p backupProgress) error {
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(progressPath(id)), 0o755); err != nil {
		return err
	}
	return writeBackupFile(progressPath(id), raw, 0o644)
}

func readProgress(id string) (*backupProgress, bool) {
	raw, err := os.ReadFile(progressPath(id))
	if err != nil {
		return nil, false
	}
	var p backupProgress
	if json.Unmarshal(raw, &p) != nil {
		return nil, false
	}
	return &p, true
}

// liveProgress is the progress of a run in progress. The progress file of a run that
// ended without clearing it (killed, or the host went down) is removed.
func liveProgress(id string) (*backupProgress, bool) {
	p, ok := readProgress(id)
	if !ok {
		return nil, false
	}
	if !runActive(id) {
		clearProgress(id)
		return nil, false
	}
	return p, true
}

func clearProgress(id string) {
	os.Remove(progressPath(id))
}
