package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustJSON(v any) json.RawMessage { b, _ := json.Marshal(v); return b }

func TestPlanSaveWritesConfigAndTimer(t *testing.T) {
	calls := useUnits(t)
	c := sampleConfig()
	c.Plans = nil
	_ = saveBackupConfig(c)
	p := planFor(t, "backup.plan.save", map[string]any{"plan": sampleConfig().Plans[0]})
	if _, ok, _ := p.execute(); !ok {
		t.Fatal("apply failed")
	}
	got, _, _ := loadBackupConfig()
	if len(got.Plans) != 1 {
		t.Fatalf("%+v", got)
	}
	if _, err := os.Stat(filepath.Join(systemdDir(), planTimerName(planA))); err != nil {
		t.Fatal("no timer file")
	}
	joined := strings.Join(*calls, "\n")
	if !strings.Contains(joined, "daemon-reload") || !strings.Contains(joined, "enable --now "+planTimerName(planA)) {
		t.Fatalf("calls %s", joined)
	}
}

func TestPlanSaveManualRemovesTimer(t *testing.T) {
	calls := useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	timer := filepath.Join(systemdDir(), planTimerName(planA))
	_ = os.WriteFile(timer, []byte("x"), 0o644)
	pl := sampleConfig().Plans[0]
	pl.Schedule.Every = "manual"
	p := planFor(t, "backup.plan.save", map[string]any{"plan": pl})
	if _, ok, _ := p.execute(); !ok {
		t.Fatal("apply failed")
	}
	if _, err := os.Stat(timer); !os.IsNotExist(err) {
		t.Fatal("timer kept")
	}
	if !strings.Contains(strings.Join(*calls, "\n"), "disable --now "+planTimerName(planA)) {
		t.Fatalf("calls %v", *calls)
	}
}

func TestPlanSaveRejectsInvalid(t *testing.T) {
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	pl := sampleConfig().Plans[0]
	pl.Name = ""
	if _, ferr := buildPlan("backup.plan.save", mustJSON(map[string]any{"plan": pl})); ferr == nil || ferr.Code != "EINVALID" {
		t.Fatalf("%+v", ferr)
	}
	pl = sampleConfig().Plans[0]
	pl.Versions.StopApps = []string{"ghost"}
	if _, ferr := buildPlan("backup.plan.save", mustJSON(map[string]any{"plan": pl})); ferr == nil || ferr.Code != "EINVALID" {
		t.Fatalf("unknown app: %+v", ferr)
	}
}

func TestPlanRemoveRefusedWhileRunning(t *testing.T) {
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_ = writeProgress(planA, backupProgress{})
	if _, ferr := buildPlan("backup.plan.remove", mustJSON(map[string]any{"id": planA})); ferr == nil || ferr.Code != "EBUSY" {
		t.Fatalf("%+v", ferr)
	}
	clearProgress(planA)
	p := planFor(t, "backup.plan.remove", map[string]any{"id": planA})
	if _, ok, _ := p.execute(); !ok {
		t.Fatal("apply failed")
	}
	if got, _, _ := loadBackupConfig(); len(got.Plans) != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestRepositorySavePreviewHasNoSecret(t *testing.T) {
	useUnits(t)
	fakeRestic(t, nil, map[string]int{"cat": 10})
	r := sampleConfig().Repositories[0]
	r.Type, r.Endpoint, r.Bucket, r.Path = "s3", "s3.example.com", "hsi-bkt", ""
	p := planFor(t, "backup.repository.save", map[string]any{"repository": r, "secrets": map[string]string{"accessKeyId": "AKIDXYZ", "secretAccessKey": "SKEYXYZ"}})
	b, _ := json.Marshal(p.Steps)
	if strings.Contains(string(b), "AKIDXYZ") || strings.Contains(string(b), "SKEYXYZ") {
		t.Fatalf("secret in preview: %s", b)
	}
	if strings.Contains(string(p.FingerprintInput), "SKEYXYZ") {
		t.Fatal("secret in fingerprint input")
	}
}

func TestRepositorySaveCreatesAndRepliesPassword(t *testing.T) {
	useUnits(t)
	fakeRestic(t, nil, map[string]int{"cat": 10})
	p := planFor(t, "backup.repository.save", map[string]any{"repository": sampleConfig().Repositories[0], "secrets": map[string]string{}})
	if _, ok, _ := p.execute(); !ok {
		t.Fatal("apply failed")
	}
	pw, _ := p.Reply["password"].(string)
	if len(pw) < 40 {
		t.Fatalf("password %q", pw)
	}
	s, _ := readRepoSecrets(repoA)
	if s.Password != pw {
		t.Fatal("stored password differs")
	}
}

func TestRepositorySaveExistingNeedsPassword(t *testing.T) {
	useUnits(t)
	calls := fakeRestic(t, nil, map[string]int{"cat": 12})
	_, ferr := buildPlan("backup.repository.save", mustJSON(map[string]any{"repository": sampleConfig().Repositories[0], "secrets": map[string]string{}}))
	if ferr == nil || ferr.Code != "EPASSWORD" || !strings.Contains(ferr.Message, "already holds") {
		t.Fatalf("%+v", ferr)
	}
	if pw := envValue((*calls)[0].env, "RESTIC_PASSWORD"); pw == "" {
		t.Fatal("restic refuses an empty password, the probe needs a throwaway one")
	}
}

func TestRepositorySaveWrongPassword(t *testing.T) {
	useUnits(t)
	fakeRestic(t, nil, map[string]int{"cat": 12})
	_, ferr := buildPlan("backup.repository.save", mustJSON(map[string]any{"repository": sampleConfig().Repositories[0], "secrets": map[string]string{"password": "nope"}}))
	if ferr == nil || ferr.Code != "EPASSWORD" || !strings.Contains(ferr.Message, "Wrong password") {
		t.Fatalf("%+v", ferr)
	}
}

func TestRepositorySaveUnreachable(t *testing.T) {
	useUnits(t)
	fakeRestic(t, nil, map[string]int{"cat": 1})
	_, ferr := buildPlan("backup.repository.save", mustJSON(map[string]any{"repository": sampleConfig().Repositories[0], "secrets": map[string]string{}}))
	if ferr == nil || ferr.Code != "EUNREACHABLE" {
		t.Fatalf("%+v", ferr)
	}
}

func TestRepositorySaveKeepsSecretsWhenBlank(t *testing.T) {
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "keep", SecretAccessKey: "old"})
	fakeRestic(t, nil, map[string]int{"cat": 0})
	r := sampleConfig().Repositories[0]
	r.Name = "USB renamed"
	p := planFor(t, "backup.repository.save", map[string]any{"repository": r, "secrets": map[string]string{"password": "", "secretAccessKey": ""}})
	if _, ok, _ := p.execute(); !ok {
		t.Fatal("apply failed")
	}
	s, _ := readRepoSecrets(repoA)
	if s.Password != "keep" || s.SecretAccessKey != "old" {
		t.Fatalf("%+v", s)
	}
}

func TestRepositoryRemoveRefusedWhenUsed(t *testing.T) {
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_, ferr := buildPlan("backup.repository.remove", mustJSON(map[string]any{"id": repoA}))
	if ferr == nil || ferr.Code != "EINUSE" {
		t.Fatalf("%+v", ferr)
	}
}

func TestRepositoryRemoveDeletesSecretsAndConfig(t *testing.T) {
	useUnits(t)
	c := sampleConfig()
	c.Plans = nil
	_ = saveBackupConfig(c)
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "p"})
	p := planFor(t, "backup.repository.remove", map[string]any{"id": repoA})
	if _, ok, _ := p.execute(); !ok {
		t.Fatal("apply failed")
	}
	if _, err := readRepoSecrets(repoA); err == nil {
		t.Fatal("secrets kept")
	}
	if got, _, _ := loadBackupConfig(); len(got.Repositories) != 0 {
		t.Fatalf("%+v", got)
	}
}

func TestRestoreOriginalNeedsConfirmation(t *testing.T) {
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "p"})
	fakeRestic(t, map[string][]string{"restore": {`{"message_type":"summary","files_restored":3,"total_files":3}`}}, nil)
	in := map[string]any{"repository": repoA, "snapshot": "abcdef12", "path": "/srv/data/photos", "target": "original"}
	if _, ferr := buildPlan("backup.restore", mustJSON(in)); ferr == nil || ferr.Code != "ECONFIRM" {
		t.Fatalf("%+v", ferr)
	}
	in["confirmOverwrite"] = true
	p := planFor(t, "backup.restore", in)
	if !p.Steps[0].Destructive {
		t.Fatal("overwrite not marked destructive")
	}
}

func TestRestoreRejectsBadInput(t *testing.T) {
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "p"})
	calls := fakeRestic(t, nil, nil)
	for _, c := range []struct{ snap, path string }{
		{"--help", "/srv/data/photos"}, {"abc", "/srv/data/photos"}, {"ABCDEF12", "/srv/data/photos"},
		{"abcdef12", "srv/data"}, {"abcdef12", "-x"}, {"abcdef12", ""},
	} {
		in := map[string]any{"repository": repoA, "snapshot": c.snap, "path": c.path, "target": "new"}
		if _, ferr := buildPlan("backup.restore", mustJSON(in)); ferr == nil || ferr.Code != "EINVALID" {
			t.Errorf("%+v accepted: %+v", c, ferr)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("restic called: %v", *calls)
	}
}

func TestRestoreNewStartsUnitAndRunRequestLogs(t *testing.T) {
	calls := useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "p"})
	fakeRestic(t, map[string][]string{
		"snapshots": {`[{"id":"abcdef1234567890","short_id":"abcdef12","time":"2026-03-04T05:06:07Z","paths":["/srv/data/photos"],"tags":[]}]`},
		"restore":   {`{"message_type":"summary","files_restored":3,"total_files":4}`},
	}, nil)
	in := map[string]any{"repository": repoA, "snapshot": "abcdef12", "path": "/srv/data/photos", "target": "new"}
	p := planFor(t, "backup.restore", in)
	if p.Steps[0].Destructive || !strings.Contains(p.Steps[0].Summary, "(3 files)") {
		t.Fatalf("%+v", p.Steps[0])
	}
	if _, ok, _ := p.execute(); !ok {
		t.Fatal("apply failed")
	}
	id, _ := p.Reply["runId"].(string)
	if !backupIDPattern.MatchString(id) {
		t.Fatalf("runId %q", id)
	}
	file := filepath.Join(backupStateDir(), "restores", id+".json")
	if st, err := os.Stat(file); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("request file: %v", err)
	}
	if !strings.Contains(strings.Join(*calls, "\n"), "systemd-run --unit hsi-restore-"+id+" --collect") {
		t.Fatalf("calls %v", *calls)
	}
	if err := runRestoreRequest(file); err != nil {
		t.Fatal(err)
	}
	runs, _ := lastRuns("restores", repoA, 5)
	if len(runs) != 1 || runs[0].Status != "success" || runs[0].Files != 3 {
		t.Fatalf("%+v", runs)
	}
	if _, ok := readProgress(id); ok {
		t.Fatal("progress kept")
	}
}
