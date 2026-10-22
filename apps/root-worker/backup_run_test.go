package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

type appsFake struct {
	running   map[string]bool
	calls     []string
	failStart string
}

func fakeApps(t *testing.T, f *appsFake) {
	pr, pa := composeRunning, composeAction
	composeRunning = func(a string) (bool, error) { return f.running[a], nil }
	composeAction = func(_ context.Context, a string, args ...string) error {
		f.calls = append(f.calls, a+" "+args[0])
		if args[0] == "start" && a == f.failStart {
			return errors.New("port in use")
		}
		return nil
	}
	t.Cleanup(func() { composeRunning, composeAction = pr, pa })
}

func setupVersionsPlan(t *testing.T, stopApps ...string) {
	useBackupDirs(t)
	c := sampleConfig()
	c.Plans[0].Versions.StopApps = stopApps
	if err := saveBackupConfig(c); err != nil {
		t.Fatal(err)
	}
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "p"})
	prev := volumeAvailable
	volumeAvailable = func(string) error { return nil }
	t.Cleanup(func() { volumeAvailable = prev })
}

var summaryLine = `{"message_type":"summary","snapshot_id":"snap1","files_new":3,"data_added":10}`

func TestRunVersionsStopsAndStartsApps(t *testing.T) {
	setupVersionsPlan(t, "vaultwarden", "jellyfin")
	f := &appsFake{running: map[string]bool{"vaultwarden": true}}
	fakeApps(t, f)
	calls := fakeRestic(t, map[string][]string{"backup": {summaryLine}}, nil)
	if err := runPlan(planA, false, time.Now); err != nil {
		t.Fatal(err)
	}
	if strings.Join(f.calls, ",") != "vaultwarden stop,vaultwarden start" {
		t.Fatalf("apps %v", f.calls)
	}
	backupArgs := strings.Join((*calls)[0].args, " ")
	if !strings.Contains(backupArgs, "--tag consistent") || !strings.Contains(backupArgs, "--tag plan:"+planA) {
		t.Fatalf("args %q", backupArgs)
	}
	if !strings.Contains(strings.Join((*calls)[1].args, " "), "forget") {
		t.Fatal("no forget after the snapshot")
	}
	runs, _ := lastRuns("runs", planA, 1)
	if runs[0].Status != "success" || runs[0].SnapshotID != "snap1" || runs[0].Consistent == nil || !*runs[0].Consistent {
		t.Fatalf("%+v", runs[0])
	}
}

func TestRunVersionsRestartsAppsWhenSnapshotFails(t *testing.T) {
	setupVersionsPlan(t, "vaultwarden")
	f := &appsFake{running: map[string]bool{"vaultwarden": true}}
	fakeApps(t, f)
	fakeRestic(t, nil, map[string]int{"backup": 1})
	if err := runPlan(planA, false, time.Now); err == nil {
		t.Fatal("expected failure")
	}
	if strings.Join(f.calls, ",") != "vaultwarden stop,vaultwarden start" {
		t.Fatalf("apps %v", f.calls)
	}
	runs, _ := lastRuns("runs", planA, 1)
	if runs[0].Status != "failed" {
		t.Fatalf("%+v", runs[0])
	}
}

func TestRunVersionsRestartsAppsWhenStartFails(t *testing.T) {
	setupVersionsPlan(t, "vaultwarden")
	fakeApps(t, &appsFake{running: map[string]bool{"vaultwarden": true}, failStart: "vaultwarden"})
	fakeRestic(t, map[string][]string{"backup": {summaryLine}}, nil)
	if err := runPlan(planA, false, time.Now); err == nil {
		t.Fatal("expected failure")
	}
	runs, _ := lastRuns("runs", planA, 1)
	if runs[0].Status != "failed" || !strings.Contains(runs[0].Error, "vaultwarden did not start again") || runs[0].SnapshotID != "snap1" {
		t.Fatalf("%+v", runs[0])
	}
}

func TestRunVersionsRefusesMissingVolume(t *testing.T) {
	setupVersionsPlan(t, "vaultwarden")
	volumeAvailable = func(string) error { return errors.New("/srv/data: missing") }
	f := &appsFake{running: map[string]bool{"vaultwarden": true}}
	fakeApps(t, f)
	calls := fakeRestic(t, nil, nil)
	if err := runPlan(planA, false, time.Now); err == nil {
		t.Fatal("expected failure")
	}
	if len(f.calls) != 0 || len(*calls) != 0 {
		t.Fatalf("touched apps %v or restic %v", f.calls, *calls)
	}
}

func TestRunVersionsMarksInconsistentWhenStopFails(t *testing.T) {
	setupVersionsPlan(t, "vaultwarden")
	fakeApps(t, &appsFake{running: map[string]bool{"vaultwarden": true}})
	composeAction = func(_ context.Context, a string, args ...string) error {
		if args[0] == "stop" {
			return errors.New("timeout")
		}
		return nil
	}
	calls := fakeRestic(t, map[string][]string{"backup": {summaryLine}}, nil)
	_ = runPlan(planA, false, time.Now)
	if !strings.Contains(strings.Join((*calls)[0].args, " "), "--tag inconsistent") {
		t.Fatal("not tagged inconsistent")
	}
	runs, _ := lastRuns("runs", planA, 1)
	if runs[0].Consistent == nil || *runs[0].Consistent {
		t.Fatalf("%+v", runs[0])
	}
}

func TestRunCheckRecordsResult(t *testing.T) {
	setupVersionsPlan(t)
	fakeRestic(t, nil, map[string]int{"check": 1})
	if err := runCheck(repoA, false, time.Now); err == nil {
		t.Fatal("expected failure")
	}
	runs, _ := lastRuns("checks", repoA, 1)
	if runs[0].Status != "failed" {
		t.Fatalf("%+v", runs[0])
	}
}

func TestRunVersionsStartsAppsBeforeForget(t *testing.T) {
	setupVersionsPlan(t, "vaultwarden")
	var seq []string
	fakeApps(t, &appsFake{running: map[string]bool{"vaultwarden": true}})
	composeAction = func(_ context.Context, a string, args ...string) error {
		seq = append(seq, a+" "+args[0])
		return nil
	}
	fakeRestic(t, map[string][]string{"backup": {summaryLine}}, nil)
	inner := runResticFiles
	runResticFiles = func(env, args []string, extra []*os.File, onLine func([]byte)) (int, string, error) {
		if strings.Contains(strings.Join(args, " "), "forget") {
			seq = append(seq, "forget")
		}
		return inner(env, args, extra, onLine)
	}
	if err := runPlan(planA, false, time.Now); err != nil {
		t.Fatal(err)
	}
	if strings.Join(seq, ",") != "vaultwarden stop,vaultwarden start,forget" {
		t.Fatalf("order %v", seq)
	}
}

func TestRunVersionsStartsAppsWhoseStopFailed(t *testing.T) {
	setupVersionsPlan(t, "vaultwarden")
	var calls []string
	fakeApps(t, &appsFake{running: map[string]bool{"vaultwarden": true}})
	composeAction = func(_ context.Context, a string, args ...string) error {
		calls = append(calls, a+" "+args[0])
		if args[0] == "stop" {
			return errors.New("timeout")
		}
		return nil
	}
	fakeRestic(t, map[string][]string{"backup": {summaryLine}}, nil)
	_ = runPlan(planA, false, time.Now)
	if strings.Join(calls, ",") != "vaultwarden stop,vaultwarden start" {
		t.Fatalf("calls %v", calls)
	}
}

func TestRunVersionsRecordsUnknownRepository(t *testing.T) {
	setupVersionsPlan(t)
	c := sampleConfig()
	c.Plans[0].Versions.Repository = planA
	if err := saveBackupConfig(c); err != nil {
		t.Fatal(err)
	}
	if err := runPlan(planA, false, time.Now); err == nil {
		t.Fatal("expected failure")
	}
	runs, _ := lastRuns("runs", planA, 1)
	if len(runs) != 1 || runs[0].Status != "failed" || !strings.Contains(runs[0].Error, "repository") {
		t.Fatalf("%+v", runs)
	}
}
