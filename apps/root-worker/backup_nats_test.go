package main

import (
	"encoding/json"
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
		if c == "systemctl daemon-reload" || c == "daemon-reload" {
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

func TestRunNowBusyAndStart(t *testing.T) {
	calls := useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	if fe := backupRunNow(planA); fe != nil {
		t.Fatal(fe)
	}
	if len(*calls) != 1 || !strings.Contains((*calls)[0], "start --no-block hsi-backup@"+planA+".service") {
		t.Fatalf("%v", *calls)
	}
	_ = writeProgress(planA, backupProgress{})
	if fe := backupRunNow(planA); fe == nil || fe.Code != "EBUSY" {
		t.Fatalf("%v", fe)
	}
}

func TestCheckNowFullUsesSystemdRun(t *testing.T) {
	calls := useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	if fe := backupCheckNow(repoA, true); fe != nil {
		t.Fatal(fe)
	}
	got := (*calls)[0]
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
