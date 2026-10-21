package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStatusHasNoSecret(t *testing.T) {
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "TOPSECRETPW", SecretAccessKey: "SKEY"})
	st := backupStatus()
	b, _ := json.Marshal(st)
	if strings.Contains(string(b), "TOPSECRETPW") || strings.Contains(string(b), "SKEY") {
		t.Fatalf("secret in status: %s", b)
	}
	if !strings.Contains(string(b), `"hasPassword":true`) {
		t.Fatalf("hasPassword missing: %s", b)
	}
}

func TestMigrateConvertsRsyncRows(t *testing.T) {
	useUnits(t)
	rows := []map[string]any{{
		"id": planA, "name": "Old sync", "direction": "push", "source": "/srv/a", "destination": "/srv/b",
		"remoteHost": nil, "remoteUser": nil, "remotePort": 22, "sshKeyPath": nil,
		"schedule": "weekly", "scheduleHour": 3, "scheduleMinute": 15, "scheduleWeekday": 1,
		"deleteExtra": true, "compress": true, "bandwidthLimit": nil, "excludes": `["*.tmp"]`, "enabled": true,
	}}
	n, skipped, err := migrateRsyncPlans(rows)
	if err != nil || n != 1 || len(skipped) != 0 {
		t.Fatalf("%d %v %v", n, skipped, err)
	}
	c, _, _ := loadBackupConfig()
	p := c.Plans[0]
	if p.Type != "sync" || p.Sync.Excludes[0] != "*.tmp" || p.Schedule.Weekday != 1 || p.Schedule.Minute != 15 || !p.Sync.DeleteExtra {
		t.Fatalf("%+v %+v", p, p.Sync)
	}
	again, _, _ := migrateRsyncPlans(rows)
	if again != 0 {
		t.Fatal("migrated twice")
	}
}

func TestMigrateSkipsInvalidRow(t *testing.T) {
	useUnits(t)
	rows := []map[string]any{{"id": planA, "name": "Bad", "direction": "push", "source": "relative", "destination": "/srv/b", "schedule": "manual", "excludes": "[]", "enabled": true}}
	n, skipped, err := migrateRsyncPlans(rows)
	if err != nil || n != 0 || len(skipped) != 1 {
		t.Fatalf("%d %v %v", n, skipped, err)
	}
}

func TestMigrateWritesTimersWithOneReload(t *testing.T) {
	calls := useUnits(t)
	rows := []map[string]any{{"id": planA, "name": "Nightly", "direction": "push", "source": "/srv/a", "destination": "/srv/b",
		"remotePort": 22, "schedule": "daily", "scheduleHour": 1, "scheduleMinute": 0, "excludes": "[]", "enabled": true}}
	if n, _, err := migrateRsyncPlans(rows); err != nil || n != 1 {
		t.Fatalf("%d %v", n, err)
	}
	reloads := 0
	for _, c := range *calls {
		if c == "daemon-reload" {
			reloads++
		}
	}
	if reloads != 1 {
		t.Fatalf("reloads %d in %v", reloads, *calls)
	}
}

func TestReadsRejectDashValues(t *testing.T) {
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	called := false
	prev := runRestic
	runRestic = func(env, args []string, onLine func([]byte)) (int, string, error) { called = true; return 0, "", nil }
	t.Cleanup(func() { runRestic = prev })
	snap := "0123456789abcdef"
	cases := []struct{ repo, snap, path string }{
		{"-x", snap, "/a"}, {repoA, "--help", "/a"}, {repoA, "zz", "/a"}, {repoA, snap, "-rf"}, {repoA, snap, "rel"},
	}
	for _, c := range cases {
		if _, fe := backupLs(c.repo, c.snap, c.path); fe == nil {
			t.Errorf("ls accepted %+v", c)
		}
	}
	if _, fe := backupSnapshots("--bad"); fe == nil {
		t.Error("snapshots accepted --bad")
	}
	if called {
		t.Fatal("restic reached with an invalid value")
	}
}

// holdRun holds the run lock of id as a running backup command does.
func holdRun(t *testing.T, id string) func() {
	t.Helper()
	release, err := holdRunLock(id)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(release)
	return release
}

func TestRunNowBusyAndStart(t *testing.T) {
	calls := useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	if fe := backupRunNow(planA); fe != nil {
		t.Fatal(fe)
	}
	got := (*calls)[0]
	if len(*calls) != 1 || !strings.HasPrefix(got, "systemd-run --unit hsi-backup-run-"+planA+" --collect") ||
		!strings.Contains(got, "-p TimeoutStopSec=120s") || !strings.HasSuffix(got, "backup run "+planA+" --manual") {
		t.Fatalf("%v", *calls)
	}
	holdRun(t, planA)
	if fe := backupRunNow(planA); fe == nil || fe.Code != "EBUSY" {
		t.Fatalf("%v", fe)
	}
}

func TestCheckNowFullUsesSystemdRun(t *testing.T) {
	calls := useUnits(t)
	t.Setenv("HSI_TEST_MARKER", "1")
	_ = saveBackupConfig(sampleConfig())
	if fe := backupCheckNow(repoA, true); fe != nil {
		t.Fatal(fe)
	}
	got := (*calls)[0]
	if !strings.Contains(got, "--setenv=HSI_TEST_MARKER=1") {
		t.Fatalf("HSI env not forwarded: %s", got)
	}
	if !strings.HasPrefix(got, "systemd-run --unit hsi-backup-check-full-"+repoA+" --collect") || !strings.HasSuffix(got, "backup check "+repoA+" --full") {
		t.Fatalf("%s", got)
	}
	if fe := backupCheckNow(repoA, false); fe != nil {
		t.Fatal(fe)
	}
	if (*calls)[1] != "start --no-block hsi-backup-check@"+repoA+".service" {
		t.Fatalf("%v", *calls)
	}
}

func TestSnapshotViewFromTags(t *testing.T) {
	v := snapshotView(snapshot{ID: "abc", Tags: []string{"hsi", "plan:" + planA, "inconsistent"}})
	if v.Consistent || v.Plan != planA {
		t.Fatalf("%+v", v)
	}
	if !snapshotView(snapshot{Tags: []string{"consistent"}}).Consistent {
		t.Fatal("consistent tag")
	}
}

func TestRestoreStatusFindsEachRun(t *testing.T) {
	useUnits(t)
	runA, runB := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	_ = appendRun("restores", repoA, runRecord{RunID: runA, Status: "failed", Error: "first"})
	_ = appendRun("restores", repoA, runRecord{RunID: runB, Status: "success"})
	for run, want := range map[string]string{runA: "failed", runB: "success"} {
		out := backupRestoreStatus(run)
		rec, _ := out["result"].(*runRecord)
		if rec == nil || rec.Status != want {
			t.Fatalf("%s: %+v", run, out)
		}
	}
	release := holdRun(t, runA)
	_ = writeProgress(runA, backupProgress{FilesDone: 2})
	if out := backupRestoreStatus(runA); out["progress"] == nil || out["result"] != nil {
		t.Fatalf("%+v", out)
	}
	release()
	// The run died without clearing its progress: it is not running any more.
	if out := backupRestoreStatus(runA); out["progress"] != nil || out["result"] == nil {
		t.Fatalf("stale progress reported: %+v", out)
	}
	if out := backupRestoreStatus("cccccccc-cccc-4ccc-8ccc-cccccccccccc"); out["result"] != nil || out["progress"] != nil {
		t.Fatalf("%+v", out)
	}
}

func TestStaleTimersAreRemoved(t *testing.T) {
	calls := useUnits(t)
	stale := filepath.Join(systemdDir(), planTimerName(planA))
	staleCheck := filepath.Join(systemdDir(), checkTimerName(repoA))
	_ = os.WriteFile(stale, []byte("x"), 0o644)
	_ = os.WriteFile(staleCheck, []byte("x"), 0o644)
	if err := writeAllTimers(backupConfig{}); err != nil {
		t.Fatal(err)
	}
	if fileExists(stale) || fileExists(staleCheck) {
		t.Fatal("stale timer file kept")
	}
	all := strings.Join(*calls, "\n")
	if !strings.Contains(all, "disable --now "+planTimerName(planA)) || !strings.Contains(all, "disable --now "+checkTimerName(repoA)) {
		t.Fatalf("%s", all)
	}
	if strings.Count(all, "daemon-reload") != 1 {
		t.Fatalf("%s", all)
	}
}
