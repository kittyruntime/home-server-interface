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
// once: a failure is recorded as rollback-failed, never retried. When the stack cannot
// be stopped or From is not installed, nothing is restored; when a restore fails,
// nothing is started. last.json is
// written and the in-progress marker cleared before it returns.
func rollback(snapshotDir, step, reason string) error {
	manual := fmt.Sprintf("run 'sudo %s-worker update rollback --snapshot %s'", unitPrefix(), snapshotDir)
	failed := func(from, to string, err error) error {
		logger.Error("update: rollback failed", "snapshot", snapshotDir, "error", err.Error())
		_ = writeLast(lastResult{From: from, To: to, Status: "rollback-failed", Step: step,
			Reason: fmt.Sprintf("%s; the rollback failed: %v (snapshot %s; %s)", reason, err, snapshotDir, manual)})
		clearInProgress()
		return err
	}
	m, err := readManifest(snapshotDir)
	if err != nil {
		from, to := "", ""
		if p, _ := readInProgress(); p != nil {
			from, to = p.From, p.To
		}
		return failed(from, to, err)
	}
	logger.Warn("update: rolling back", "from", m.To, "to", m.From, "step", step, "reason", reason)
	target := unitPrefix() + ".target"
	if out, err := systemctl("stop", target); err != nil {
		return failed(m.From, m.To, fmt.Errorf("stop %s: %s", target, cmdErrMessage(out, err)))
	}
	if err := switchCurrent(m.From); err != nil {
		return failed(m.From, m.To, fmt.Errorf("%w; the services are left stopped", err))
	}
	var errs []string
	if err := restoreDatabase(snapshotDir, m); err != nil {
		errs = append(errs, "restore the database: "+err.Error())
	}
	if err := restoreFiles(snapshotDir, m); err != nil {
		errs = append(errs, err.Error())
	}
	if len(errs) > 0 {
		return failed(m.From, m.To, fmt.Errorf("%s; the services are left stopped", strings.Join(errs, "; ")))
	}
	if out, err := systemctl("daemon-reload"); err != nil {
		errs = append(errs, "daemon-reload: "+cmdErrMessage(out, err))
	}
	if out, err := systemctl("start", target); err != nil {
		errs = append(errs, "start "+target+": "+cmdErrMessage(out, err))
	}
	if len(errs) == 0 {
		if err := waitHealthy(healthTargetFor(m.From)); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if len(errs) > 0 {
		return failed(m.From, m.To, errors.New(strings.Join(errs, "; ")))
	}
	removeFailedRelease(snapshotDir, m)
	err = writeLast(lastResult{From: m.From, To: m.To, Status: "rolled-back", Step: step, Reason: reason})
	clearInProgress()
	pruneUpdateState()
	return err
}

// removeFailedRelease deletes releases/<To> once the rollback to From succeeded,
// unless it is current or another snapshot still rolls back to it.
func removeFailedRelease(snapshotDir string, m snapshotManifest) {
	if m.To == m.From || m.To == currentVersion() {
		return
	}
	for _, s := range listSnapshots() {
		if s.Dir != filepath.Clean(snapshotDir) && s.Manifest.From == m.To {
			return
		}
	}
	if err := removeRelease(m.To); err != nil {
		logger.Warn("update: could not remove the failed release", "version", m.To, "error", err.Error())
	}
}

// restoreDatabase puts the snapshot database in place. The copies are staged first,
// so a failed copy leaves the live database and its journals as they were; then the
// journals of the version rolled back from are renamed aside (they would be replayed
// over the restored file), the copies renamed into place, and the journals set aside
// removed, or put back when the database could not be renamed.
func restoreDatabase(dir string, m snapshotManifest) error {
	snap, err := openDirNoFollow(dir)
	if err != nil {
		return err
	}
	defer snap.Close()
	src, err := descendDirs(snap, filepath.Dir(m.Database))
	if err != nil {
		return err
	}
	defer src.Close()
	name := filepath.Base(m.Database)
	dst, base, err := openParentNoFollow(m.DBTarget)
	if err != nil {
		return err
	}
	defer dst.Close()
	tmpDB, err := stageAt(src, name, dst, base, 0, false)
	if err != nil {
		return err
	}
	tmpWAL := ""
	if _, err := statAt(src, name+"-wal"); err == nil {
		if tmpWAL, err = stageAt(src, name+"-wal", dst, base+"-wal", 0, false); err != nil {
			_ = removeAt(dst, tmpDB)
			return err
		}
	}
	dropStaged := func() {
		_ = removeAt(dst, tmpDB)
		if tmpWAL != "" {
			_ = removeAt(dst, tmpWAL)
		}
	}
	// The live journals are renamed aside, not removed, until the database is in
	// place: a failed rename of the database puts them back.
	var aside []string
	putBack := func() {
		for _, ext := range aside {
			_ = renameat(int(dst.Fd()), base+ext+".hsi-old", int(dst.Fd()), base+ext)
		}
	}
	for _, ext := range []string{"-wal", "-shm", "-journal"} {
		if _, err := statAt(dst, base+ext); errors.Is(err, syscall.ENOENT) {
			continue
		}
		if err := removeAt(dst, base+ext+".hsi-old"); err == nil {
			err = renameat(int(dst.Fd()), base+ext, int(dst.Fd()), base+ext+".hsi-old")
			if err == nil {
				aside = append(aside, ext)
				continue
			}
		}
		putBack()
		dropStaged()
		return fmt.Errorf("set the journal %s aside: %w", base+ext, err)
	}
	if err := commitAt(dst, tmpDB, base); err != nil {
		putBack()
		dropStaged()
		return err
	}
	for _, ext := range aside {
		_ = removeAt(dst, base+ext+".hsi-old")
	}
	if tmpWAL != "" {
		return commitAt(dst, tmpWAL, base+"-wal")
	}
	return nil
}

// restoreFiles puts back each snapshotted file with its mode, removes those that did
// not exist, and removes unit files of the prefix created since the snapshot along
// with the *.wants links to them.
func restoreFiles(dir string, m snapshotManifest) error {
	snap, err := openDirNoFollow(dir)
	if err != nil {
		return err
	}
	defer snap.Close()
	var failed []string
	listed := map[string]bool{}
	removed := map[string]bool{}
	unitsListed := false
	for _, f := range m.Files {
		listed[f.Src] = true
		if isUnitPath(f.Src) {
			unitsListed = true
		}
		if err := restoreFile(snap, f); err != nil {
			failed = append(failed, fmt.Sprintf("restore %s: %v", f.Src, err))
		} else if !f.Existed && isUnitPath(f.Src) {
			removed[filepath.Base(f.Src)] = true
		}
	}
	// Only a snapshot that lists units knows which ones are new.
	if unitsListed {
		if err := removeNewUnits(listed, removed); err != nil {
			failed = append(failed, err.Error())
		}
	}
	if len(failed) > 0 {
		return errors.New(strings.Join(failed, "; "))
	}
	return nil
}

func restoreFile(snap *os.File, f snapFile) error {
	dst, base, err := openParentNoFollow(f.Src)
	if errors.Is(err, syscall.ENOENT) {
		if !f.Existed {
			return nil
		}
		// A folder removed since the snapshot comes back root-owned, 0755.
		dst, err = walkDirNoFollow(filepath.Dir(f.Src), restoreFolderName(f.Src), true, 0o755)
		base = filepath.Base(f.Src)
	}
	if err != nil {
		return err
	}
	defer dst.Close()
	if !f.Existed {
		return removeAt(dst, base)
	}
	src, err := descendDirs(snap, filepath.Dir(f.Saved))
	if err != nil {
		return err
	}
	defer src.Close()
	return copyAt(src, filepath.Base(f.Saved), dst, base, os.FileMode(f.Mode), isUnitPath(f.Src))
}

// restoreFolderName names the folder of a restored file in errors.
func restoreFolderName(src string) string {
	if isUnitPath(src) {
		return "the systemd unit folder"
	}
	return "the configuration folder of " + filepath.Base(src)
}

func removeNewUnits(listed, removed map[string]bool) error {
	sd, err := openDirNoFollow(systemdDir())
	if err != nil {
		return err
	}
	defer sd.Close()
	entries, err := readDirFd(sd)
	if err != nil {
		return err
	}
	var failed []string
	for _, e := range entries {
		p := filepath.Join(filepath.Clean(systemdDir()), e.Name())
		if !isUnitPath(p) || listed[p] {
			continue
		}
		if err := removeAt(sd, e.Name()); err != nil {
			failed = append(failed, err.Error())
			continue
		}
		removed[e.Name()] = true
	}
	for _, e := range entries {
		if !e.IsDir() || !(strings.HasSuffix(e.Name(), ".wants") || strings.HasSuffix(e.Name(), ".requires")) {
			continue
		}
		if err := removeLinksTo(sd, e.Name(), removed); err != nil {
			failed = append(failed, err.Error())
		}
	}
	if len(failed) > 0 {
		return errors.New(strings.Join(failed, "; "))
	}
	return nil
}

// removeLinksTo removes the links of systemd/<wants> that name a removed unit.
func removeLinksTo(sd *os.File, wants string, removed map[string]bool) error {
	d, err := openatDir(sd, wants)
	if err != nil {
		return err
	}
	defer d.Close()
	entries, err := readDirFd(d)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.Type()&os.ModeSymlink == 0 {
			continue
		}
		target, err := readlinkAt(d, e.Name())
		if err != nil {
			continue
		}
		if removed[e.Name()] || removed[filepath.Base(target)] {
			if err := removeAt(d, e.Name()); err != nil {
				return err
			}
		}
	}
	return nil
}

// recoverInterrupted runs at worker start: an update whose marker is still there and
// whose lock nobody holds was interrupted (killed, power cut) and is rolled back. The
// installer holds the lock until it exits, so a free lock means it is gone, whatever
// process now has the PID of the marker (kept for information). The rollback stops the stack the worker belongs
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

// latestSnapshotFor returns the newest snapshot whose To is version and whose From
// differs (a same-version snapshot has nothing to go back to).
func latestSnapshotFor(version string) (updateSnapshot, bool) {
	for _, s := range listSnapshots() {
		if s.Manifest.To == version && s.Manifest.From != version {
			return s, true
		}
	}
	return updateSnapshot{}, false
}

// snapshotAge is how a manual rollback describes the database it brings back.
func snapshotAge(created time.Time) string {
	return created.Local().Format("2006-01-02 15:04")
}
