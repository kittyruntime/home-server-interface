package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// ── I1: an interrupted run winds down instead of dying ──────────────────────

func TestInterruptedRunRestartsAppsAndRecordsInterrupted(t *testing.T) {
	setupVersionsPlan(t, "vaultwarden")
	f := &appsFake{running: map[string]bool{"vaultwarden": true}}
	fakeApps(t, f)
	calls := fakeRestic(t, nil, nil)
	inner := runRestic
	runRestic = func(env, args []string, onLine func([]byte)) (int, string, error) {
		if strings.Contains(strings.Join(args, " "), "backup") {
			// systemd stops the unit while restic runs; restic dies of the signal.
			interruptRun(syscall.SIGTERM)
			_, _, _ = inner(env, args, onLine)
			return -1, "signal: terminated", nil
		}
		return inner(env, args, onLine)
	}
	if err := runPlan(planA, false, time.Now); !errors.Is(err, errInterrupted) {
		t.Fatalf("got %v", err)
	}
	if strings.Join(f.calls, ",") != "vaultwarden stop,vaultwarden start" {
		t.Fatalf("apps %v", f.calls)
	}
	for _, c := range *calls {
		if strings.Contains(strings.Join(c.args, " "), "forget") {
			t.Fatal("pruned after an interruption")
		}
	}
	runs, _ := lastRuns("runs", planA, 1)
	if len(runs) != 1 || runs[0].Status != "failed" || runs[0].Error != "interrupted" {
		t.Fatalf("%+v", runs)
	}
	if _, ok := readProgress(planA); ok {
		t.Fatal("progress kept")
	}
}

func TestInterruptKeepsAppRestartFailure(t *testing.T) {
	setupVersionsPlan(t, "vaultwarden")
	fakeApps(t, &appsFake{running: map[string]bool{"vaultwarden": true}, failStart: "vaultwarden"})
	fakeRestic(t, nil, map[string]int{"backup": 130})
	interruptRun(syscall.SIGTERM)
	_ = runPlan(planA, false, time.Now)
	runs, _ := lastRuns("runs", planA, 1)
	if !strings.HasPrefix(runs[0].Error, "interrupted") || !strings.Contains(runs[0].Error, "vaultwarden did not start again") {
		t.Fatalf("%+v", runs[0])
	}
}

func TestInterruptReachesTheResticChild(t *testing.T) {
	useBackupDirs(t)
	stub := filepath.Join(t.TempDir(), "restic")
	script := "#!/bin/sh\ntrap 'exit 9' TERM\necho ready\nwhile :; do sleep 0.05; done\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HSI_RESTIC", stub)
	stop := catchInterrupts()
	defer stop()
	done := make(chan int, 1)
	go func() {
		code, _, _ := runRestic(nil, []string{"backup"}, func(b []byte) {
			if string(b) == "ready" {
				// To this process only: the child must get it from the worker.
				_ = syscall.Kill(os.Getpid(), syscall.SIGTERM)
			}
		})
		done <- code
	}()
	select {
	case code := <-done:
		if code != 9 || !interrupted.Load() {
			t.Fatalf("code %d interrupted %v", code, interrupted.Load())
		}
	case <-time.After(5 * time.Second):
		interruptRun(syscall.SIGKILL)
		t.Fatal("the signal did not reach restic")
	}
}

func TestInterruptWhileWaitingForTheRepository(t *testing.T) {
	useBackupDirs(t)
	err := withLock(repoA, time.Minute, func() error {
		inner := make(chan error, 1)
		go func() { inner <- withLock(repoA, time.Minute, func() error { return nil }) }()
		time.Sleep(50 * time.Millisecond)
		interruptRun(syscall.SIGTERM)
		select {
		case e := <-inner:
			return e
		case <-time.After(3 * time.Second):
			return errors.New("still waiting")
		}
	})
	if !errors.Is(err, errInterrupted) {
		t.Fatalf("got %v", err)
	}
}

func TestStaleProgressWithFreeLockIsNotRunning(t *testing.T) {
	calls := useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	// Left by a run that died with the host: the progress file survives a reboot.
	_ = writeProgress(planA, backupProgress{PercentDone: 0.4})
	st := backupStatus()
	if p := st["plans"].([]planStatus)[0]; p.Progress != nil {
		t.Fatalf("stale run shown as running: %+v", p.Progress)
	}
	if _, ok := readProgress(planA); ok {
		t.Fatal("stale progress file kept")
	}
	if fe := backupRunNow(planA); fe != nil {
		t.Fatalf("run now refused: %v", fe)
	}
	if _, ferr := buildPlan("backup.plan.remove", mustJSON(map[string]any{"id": planA})); ferr != nil {
		t.Fatalf("remove refused: %v", ferr)
	}
	if len(*calls) == 0 {
		t.Fatal("run now did not start the unit")
	}
}

func TestRunShowsProgressWhileItHoldsItsLock(t *testing.T) {
	setupVersionsPlan(t)
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "p"})
	fakeRestic(t, map[string][]string{"backup": {summaryLine}}, nil)
	inner := runRestic
	var during *backupProgress
	runRestic = func(env, args []string, onLine func([]byte)) (int, string, error) {
		if strings.Contains(strings.Join(args, " "), "backup") {
			during = backupStatus()["plans"].([]planStatus)[0].Progress
		}
		return inner(env, args, onLine)
	}
	if err := runPlan(planA, false, time.Now); err != nil {
		t.Fatal(err)
	}
	if during == nil {
		t.Fatal("not shown as running during the snapshot")
	}
	if runActive(planA) {
		t.Fatal("run lock kept after the run")
	}
}

func TestSecondRunOfAPlanIsRefused(t *testing.T) {
	setupVersionsPlan(t)
	calls := fakeRestic(t, map[string][]string{"backup": {summaryLine}}, nil)
	runLockWait = 50 * time.Millisecond
	t.Cleanup(func() { runLockWait = 5 * time.Second })
	holdRun(t, planA)
	if err := runPlan(planA, false, time.Now); !errors.Is(err, errRunActive) {
		t.Fatalf("got %v", err)
	}
	if len(*calls) != 0 {
		t.Fatal("restic ran")
	}
	if runs, _ := lastRuns("runs", planA, 5); len(runs) != 0 {
		t.Fatalf("the other run's record is its own: %+v", runs)
	}
}

// ── I2: a restored path matches itself only ─────────────────────────────────

func TestRestoreIncludeEscapesGlobCharacters(t *testing.T) {
	useBackupDirs(t)
	calls := fakeRestic(t, map[string][]string{"restore": {`{"message_type":"summary","total_files":1}`}}, nil)
	path := `/srv/data/Movie [1080p]/a*b?\c.mkv`
	if _, err := resticRestore(repositoryCfg{Type: "local", Path: "/r"}, repoSecrets{Password: "p"}, "s1", path, "/t", true, nil); err != nil {
		t.Fatal(err)
	}
	args := (*calls)[0].args
	for i, a := range args {
		if a == "--include" {
			if want := `/srv/data/Movie \[1080p\]/a\*b\?\\c.mkv`; args[i+1] != want {
				t.Fatalf("include %q, want %q", args[i+1], want)
			}
			return
		}
	}
	t.Fatalf("no --include in %v", args)
}

func restorePreviewFixture(t *testing.T, summary string) {
	t.Helper()
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "p"})
	fakeRestic(t, map[string][]string{
		"snapshots": {`[{"id":"abcdef1234567890","short_id":"abcdef12","time":"2026-03-04T05:06:07Z"}]`},
		"restore":   {summary},
	}, nil)
}

func TestRestorePreviewRefusesNothingToRestore(t *testing.T) {
	restorePreviewFixture(t, `{"message_type":"summary","files_restored":0,"total_files":0}`)
	for _, target := range []string{"new", "original"} {
		in := map[string]any{"repository": repoA, "snapshot": "abcdef12", "path": "/srv/data/Movie [1080p]", "target": target, "confirmOverwrite": true}
		_, ferr := buildPlan("backup.restore", mustJSON(in))
		if ferr == nil || ferr.Code != "ENOENT" || !strings.Contains(ferr.Message, "Nothing to restore") {
			t.Fatalf("%s: %+v", target, ferr)
		}
	}
}

func TestRestorePreviewCountsFilesNotFolders(t *testing.T) {
	// A dry run of 2 files in 7 folders: files_restored counts the folders too.
	restorePreviewFixture(t, `{"message_type":"summary","files_restored":9,"total_files":2}`)
	in := map[string]any{"repository": repoA, "snapshot": "abcdef12", "path": "/srv/data/photos", "target": "original"}
	if _, ferr := buildPlan("backup.restore", mustJSON(in)); ferr == nil || ferr.Message != "This replaces 2 files at their original location" {
		t.Fatalf("%+v", ferr)
	}
	in["target"] = "new"
	p := planFor(t, "backup.restore", in)
	if !strings.HasSuffix(p.Steps[0].Summary, "(2 files)") {
		t.Fatalf("%s", p.Steps[0].Summary)
	}
}

// ── I3: Run now on a paused plan ────────────────────────────────────────────

func pausePlan(t *testing.T) {
	t.Helper()
	c := sampleConfig()
	c.Plans[0].Enabled = false
	if err := saveBackupConfig(c); err != nil {
		t.Fatal(err)
	}
}

func TestManualRunOfPausedPlan(t *testing.T) {
	setupVersionsPlan(t)
	pausePlan(t)
	calls := fakeRestic(t, map[string][]string{"backup": {summaryLine}}, nil)
	// The timer of a paused plan is gone; one left behind records nothing.
	if err := runPlan(planA, false, time.Now); err == nil {
		t.Fatal("timer run of a paused plan accepted")
	}
	if runs, _ := lastRuns("runs", planA, 5); len(runs) != 0 || len(*calls) != 0 {
		t.Fatalf("%+v %v", runs, *calls)
	}
	if code := runBackupCLI([]string{"run", planA, "--manual"}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	runs, _ := lastRuns("runs", planA, 5)
	if len(runs) != 1 || runs[0].Status != "success" {
		t.Fatalf("%+v", runs)
	}
}

func TestRunNowStartsAPausedPlanByHand(t *testing.T) {
	calls := useUnits(t)
	pausePlan(t)
	if fe := backupRunNow(planA); fe != nil {
		t.Fatal(fe)
	}
	if !strings.HasSuffix((*calls)[0], "backup run "+planA+" --manual") {
		t.Fatalf("%v", *calls)
	}
}

func TestRunRecordsAFailureBeforeRestic(t *testing.T) {
	setupVersionsPlan(t)
	if err := os.WriteFile(backupConfigPath(), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := runPlan(planA, true, time.Now); err == nil {
		t.Fatal("expected failure")
	}
	runs, _ := lastRuns("runs", planA, 1)
	if len(runs) != 1 || runs[0].Status != "failed" || !strings.Contains(runs[0].Error, "invalid backup configuration") {
		t.Fatalf("%+v", runs)
	}
}

// ── I4: a local repository is a real, root-only folder ──────────────────────

func localRepo(path string) repositoryCfg {
	r := sampleConfig().Repositories[0]
	r.Path = path
	return r
}

func TestRepositorySaveRefusesSymlinkInLocalPath(t *testing.T) {
	useUnits(t)
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	calls := fakeRestic(t, nil, map[string]int{"cat": 10})
	for _, p := range []string{link, filepath.Join(link, "restic")} {
		_, ferr := buildPlan("backup.repository.save", mustJSON(map[string]any{"repository": localRepo(p), "secrets": map[string]string{}}))
		if ferr == nil || ferr.Code != "EINVALID" || !strings.Contains(ferr.Message, "symbolic link") {
			t.Fatalf("%s: %+v", p, ferr)
		}
	}
	if len(*calls) != 0 {
		t.Fatal("restic reached through a symlink")
	}
	open := t.TempDir()
	_ = os.Chmod(open, 0o777)
	if _, ferr := buildPlan("backup.repository.save", mustJSON(map[string]any{"repository": localRepo(open), "secrets": map[string]string{}})); ferr == nil || !strings.Contains(ferr.Message, "closed to other users") {
		t.Fatalf("a folder anyone can write to: %+v", ferr)
	}
}

func TestBrowsingRefusesAnUnsafeLocalRepository(t *testing.T) {
	setupVersionsPlan(t)
	_ = os.Chmod(testRepoPath, 0o777)
	calls := fakeRestic(t, nil, nil)
	if _, fe := backupSnapshots(repoA); fe == nil {
		t.Fatal("snapshots listed")
	}
	if _, fe := backupLs(repoA, "abcdef12", "/srv"); fe == nil {
		t.Fatal("snapshot browsed")
	}
	if len(*calls) != 0 {
		t.Fatal("restic ran")
	}
}

func TestRepositoryInitCreatesARootOnlyFolder(t *testing.T) {
	useUnits(t)
	fakeRestic(t, nil, map[string]int{"cat": 10})
	path := filepath.Join(t.TempDir(), "usb", "restic")
	p := planFor(t, "backup.repository.save", map[string]any{"repository": localRepo(path), "secrets": map[string]string{}})
	if _, ok, _ := p.execute(); !ok {
		t.Fatal("apply failed")
	}
	st, err := os.Lstat(path)
	if err != nil || !st.IsDir() || st.Mode().Perm() != 0o700 {
		t.Fatalf("%v %v", st, err)
	}
}

func TestRunFailsWhenTheLocalRepositoryIsNoLongerSafe(t *testing.T) {
	for name, spoil := range map[string]func(path string){
		"symlink": func(path string) {
			_ = os.Remove(path)
			_ = os.Symlink(t.TempDir(), path)
		},
		"writable by others": func(path string) { _ = os.Chmod(path, 0o777) },
		"missing":            func(path string) { _ = os.Remove(path) },
	} {
		setupVersionsPlan(t)
		spoil(testRepoPath)
		calls := fakeRestic(t, map[string][]string{"backup": {summaryLine}}, nil)
		if err := runPlan(planA, false, time.Now); err == nil {
			t.Errorf("%s: run accepted", name)
		}
		if err := runCheck(repoA, false, time.Now); err == nil {
			t.Errorf("%s: check accepted", name)
		}
		if len(*calls) != 0 {
			t.Errorf("%s: restic ran", name)
		}
		if runs, _ := lastRuns("runs", planA, 1); len(runs) != 1 || runs[0].Status != "failed" {
			t.Errorf("%s: %+v", name, runs)
		}
	}
}

// ── I5: timers first, then backup.json ──────────────────────────────────────

var rsyncRow = map[string]any{"id": planA, "name": "Nightly", "direction": "push", "source": "/srv/a", "destination": "/srv/b",
	"remotePort": 22, "schedule": "daily", "scheduleHour": 1, "scheduleMinute": 0, "excludes": "[]", "enabled": true}

func TestMigrationRetryWritesTheTimers(t *testing.T) {
	calls := useUnits(t)
	failing := systemctl
	systemctl = func(args ...string) ([]byte, error) {
		if args[0] == "daemon-reload" {
			return []byte("bus error"), errors.New("exit 1")
		}
		return failing(args...)
	}
	if _, _, err := migrateRsyncPlans([]map[string]any{rsyncRow}); err == nil {
		t.Fatal("expected failure")
	}
	if _, exists, _ := loadBackupConfig(); exists {
		t.Fatal("backup.json written although the timers failed: a retry would skip them")
	}
	systemctl = failing
	if n, _, err := migrateRsyncPlans([]map[string]any{rsyncRow}); err != nil || n != 1 {
		t.Fatalf("%d %v", n, err)
	}
	if !strings.Contains(strings.Join(*calls, "\n"), "enable --now "+planTimerName(planA)) {
		t.Fatalf("%v", *calls)
	}
}

func TestWorkerStartWritesMissingTimers(t *testing.T) {
	calls := useUnits(t)
	syncBackupTimers()
	if len(*calls) != 0 {
		t.Fatalf("no backup.json, yet %v", *calls)
	}
	_ = saveBackupConfig(sampleConfig())
	syncBackupTimers()
	if !fileExists(filepath.Join(systemdDir(), planTimerName(planA))) || !fileExists(filepath.Join(systemdDir(), checkTimerName(repoA))) {
		t.Fatal("timers not written at start")
	}
	*calls = nil
	syncBackupTimers()
	for _, c := range *calls {
		if c == "daemon-reload" {
			t.Fatalf("reloaded for unchanged timers: %v", *calls)
		}
	}
}

func TestStatusReportsMigrationSkippedUntilDismissed(t *testing.T) {
	useUnits(t)
	bad := map[string]any{"id": "33333333-3333-4333-8333-333333333333", "name": "Bad", "direction": "push", "source": "relative",
		"destination": "/srv/b", "schedule": "manual", "excludes": "[]", "enabled": true}
	if _, _, err := migrateRsyncPlans([]map[string]any{rsyncRow, bad}); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(backupStatus()["migrationSkipped"])
	if !strings.Contains(string(raw), `"name":"Bad"`) {
		t.Fatalf("%s", raw)
	}
	if err := dismissMigrationSkipped(); err != nil {
		t.Fatal(err)
	}
	if got := backupStatus()["migrationSkipped"].([]map[string]string); len(got) != 0 {
		t.Fatalf("%v", got)
	}
}
