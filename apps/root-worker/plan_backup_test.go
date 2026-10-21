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
	release := holdRun(t, planA)
	if _, ferr := buildPlan("backup.plan.remove", mustJSON(map[string]any{"id": planA})); ferr == nil || ferr.Code != "EBUSY" {
		t.Fatalf("%+v", ferr)
	}
	release()
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
		// files_restored counts the folders too: 3 files in 6 folders.
		"restore": {`{"message_type":"summary","files_restored":9,"total_files":3}`},
	}, nil)
	data := filepath.Join(t.TempDir(), "data")
	_ = os.MkdirAll(data, 0o755)
	in := map[string]any{"repository": repoA, "snapshot": "abcdef12", "path": filepath.Join(data, "photos"), "target": "new"}
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
	if !strings.Contains(strings.Join(*calls, "\n"), "--setenv=HSI_BACKUP_STATE="+os.Getenv("HSI_BACKUP_STATE")) {
		t.Fatalf("the unit must see the worker's HSI_* environment: %v", *calls)
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

// restoreTargets returns, for each restic restore call, the directory restic was handed
// by descriptor.
func restoreTargets(calls *[]resticCall) []string {
	var out []string
	for _, c := range *calls {
		for _, a := range c.args {
			if a == "restore" && len(c.extra) > 0 {
				out = append(out, c.extra[0])
			}
		}
	}
	return out
}

func restoreFixture(t *testing.T, rr restoreRequest) (string, *[]resticCall) {
	t.Helper()
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "p"})
	calls := fakeRestic(t, map[string][]string{"restore": {`{"message_type":"summary","files_restored":1,"total_files":1}`}}, nil)
	if rr.RunID == "" {
		rr.RunID = newRunID()
	}
	rr.Repository, rr.Snapshot = repoA, "abcdef12"
	file, err := writeRestoreRequest(rr)
	if err != nil {
		t.Fatal(err)
	}
	return file, calls
}

func TestRestoreRefusesSymlinkedRestoredDir(t *testing.T) {
	base, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(base, "Restored")); err != nil {
		t.Fatal(err)
	}
	file, calls := restoreFixture(t, restoreRequest{Mode: "new", Base: base, Name: "x", Path: filepath.Join(base, "photos")})
	if err := runRestoreRequest(file); err == nil {
		t.Fatal("restore through a symlink accepted")
	}
	if len(restoreTargets(calls)) != 0 {
		t.Fatal("restic ran")
	}
	if ents, _ := os.ReadDir(outside); len(ents) != 0 {
		t.Fatalf("written through the link: %v", ents)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("request file kept")
	}
}

func TestRestoreNeverReusesFinalDir(t *testing.T) {
	base, outside := t.TempDir(), t.TempDir()
	if err := os.Mkdir(filepath.Join(base, "Restored"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(base, "Restored", "x")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(base, "Restored", "x-2"), 0o755); err != nil {
		t.Fatal(err)
	}
	file, calls := restoreFixture(t, restoreRequest{Mode: "new", Base: base, Name: "x", Path: filepath.Join(base, "photos")})
	if err := runRestoreRequest(file); err != nil {
		t.Fatal(err)
	}
	got := restoreTargets(calls)
	if len(got) != 1 || got[0] != filepath.Join(base, "Restored", "x-3") {
		t.Fatalf("targets %v", got)
	}
	if ents, _ := os.ReadDir(outside); len(ents) != 0 {
		t.Fatalf("written through the link: %v", ents)
	}
}

func TestRestoreRecordsTheFolderActuallyCreated(t *testing.T) {
	base := t.TempDir()
	req := restoreRequest{Mode: "new", Base: base, Name: "x", Path: filepath.Join(base, "photos")}
	file, _ := restoreFixture(t, req)
	if err := runRestoreRequest(file); err != nil {
		t.Fatal(err)
	}
	req.RunID, req.Repository, req.Snapshot = newRunID(), repoA, "abcdef12"
	file, err := writeRestoreRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	if err := runRestoreRequest(file); err != nil {
		t.Fatal(err)
	}
	runs, _ := lastRuns("restores", repoA, 5)
	if len(runs) != 2 {
		t.Fatalf("%+v", runs)
	}
	// Newest first: the second restore found x taken and wrote x-2.
	if runs[0].Target != filepath.Join(base, "Restored", "x-2") || runs[1].Target != filepath.Join(base, "Restored", "x") {
		t.Fatalf("targets %q %q", runs[0].Target, runs[1].Target)
	}
	for _, r := range runs {
		if !strings.HasPrefix(r.Target, filepath.Join(base, "Restored", "x")) {
			t.Fatalf("target %q", r.Target)
		}
	}
}

func writeStaged(t *testing.T, dir, abs, content string) {
	t.Helper()
	p := filepath.Join(dir, abs)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreOriginalMergesWithoutFollowingSymlinks(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	data := filepath.Join(root, "data")
	_ = os.MkdirAll(data, 0o755)
	_ = os.WriteFile(filepath.Join(data, "a.txt"), []byte("old"), 0o644)
	_ = os.WriteFile(filepath.Join(data, "keep.txt"), []byte("keep"), 0o644)
	_ = os.MkdirAll(filepath.Join(data, "isdir"), 0o755)
	if err := os.Symlink(outside, filepath.Join(data, "linkdir")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(data, "linkfile")); err != nil {
		t.Fatal(err)
	}
	file, calls := restoreFixture(t, restoreRequest{Mode: "original", Base: root, Path: data})
	fakeResticRestore = func(dir string) {
		writeStaged(t, dir, data+"/a.txt", "new")
		writeStaged(t, dir, data+"/sub/b.txt", "b")
		writeStaged(t, dir, data+"/linkdir/c.txt", "c")
		writeStaged(t, dir, data+"/isdir", "file where a directory is")
		writeStaged(t, dir, data+"/linkfile", "replaces the link itself")
	}
	if err := runRestoreRequest(file); err != nil {
		t.Fatal(err)
	}
	read := func(p string) string { b, _ := os.ReadFile(p); return string(b) }
	if read(filepath.Join(data, "a.txt")) != "new" || read(filepath.Join(data, "sub", "b.txt")) != "b" || read(filepath.Join(data, "keep.txt")) != "keep" {
		t.Fatal("merge result wrong")
	}
	if ents, _ := os.ReadDir(outside); len(ents) != 0 {
		t.Fatalf("written through a symlink: %v", ents)
	}
	if st, err := os.Lstat(filepath.Join(data, "linkfile")); err != nil || st.Mode()&os.ModeSymlink != 0 {
		t.Fatal("a file must replace the symlink, not be written through it")
	}
	if st, err := os.Lstat(filepath.Join(data, "linkdir")); err != nil || st.Mode()&os.ModeSymlink == 0 {
		t.Fatal("symlinked directory touched")
	}
	if st, err := os.Stat(filepath.Join(data, "isdir")); err != nil || !st.IsDir() {
		t.Fatal("directory replaced by a file")
	}
	if ents, _ := os.ReadDir(filepath.Join(root, "Restored")); len(ents) != 0 {
		t.Fatalf("staging left behind: %v", ents)
	}
	runs, _ := lastRuns("restores", repoA, 1)
	if len(runs) != 1 || runs[0].Status != "success" || runs[0].Files != 3 || len(runs[0].Warnings) != 2 {
		t.Fatalf("%+v", runs)
	}
	if got := restoreTargets(calls); len(got) != 1 || !strings.Contains(got[0], "/Restored/.staging-") {
		t.Fatalf("restore goes to a staging dir: %v", got)
	}
}

func TestRestoreOriginalSkipsSymlinkedPath(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "data")); err != nil {
		t.Fatal(err)
	}
	file, _ := restoreFixture(t, restoreRequest{Mode: "original", Base: root, Path: filepath.Join(root, "data")})
	fakeResticRestore = func(dir string) { writeStaged(t, dir, filepath.Join(root, "data", "f"), "x") }
	if err := runRestoreRequest(file); err != nil {
		t.Fatal(err)
	}
	if ents, _ := os.ReadDir(outside); len(ents) != 0 {
		t.Fatalf("written through the symlinked path: %v", ents)
	}
	if ents, _ := os.ReadDir(filepath.Join(root, "Restored")); len(ents) != 0 {
		t.Fatalf("staging left behind: %v", ents)
	}
}

func TestRestoreNewRefusesSymlinkInBase(t *testing.T) {
	real, outside := t.TempDir(), t.TempDir()
	_ = os.MkdirAll(filepath.Join(real, "vol"), 0o755)
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	for _, base := range []string{link, filepath.Join(link, "vol")} {
		file, calls := restoreFixture(t, restoreRequest{Mode: "new", Base: base, Name: "x", Path: "/srv/p"})
		if err := runRestoreRequest(file); err == nil {
			t.Fatalf("%s accepted", base)
		}
		if len(restoreTargets(calls)) != 0 {
			t.Fatal("restic ran")
		}
	}
	if ents, _ := os.ReadDir(outside); len(ents) != 0 {
		t.Fatal("outside touched")
	}
	if _, err := os.Stat(filepath.Join(real, "Restored")); err == nil {
		t.Fatal("created through the link")
	}
}

func TestRestoreRefusesWritableRestored(t *testing.T) {
	base := t.TempDir()
	if err := os.Mkdir(filepath.Join(base, "Restored"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(base, "Restored"), 0o777); err != nil {
		t.Fatal(err)
	}
	file, calls := restoreFixture(t, restoreRequest{Mode: "new", Base: base, Name: "x", Path: "/srv/p"})
	if err := runRestoreRequest(file); err == nil || !strings.Contains(err.Error(), "writable by other users") {
		t.Fatalf("%v", err)
	}
	if len(restoreTargets(calls)) != 0 {
		t.Fatal("restic ran")
	}
}

func TestRestoreSurvivesRenamedRestored(t *testing.T) {
	base, outside := t.TempDir(), t.TempDir()
	file, calls := restoreFixture(t, restoreRequest{Mode: "new", Base: base, Name: "x", Path: "/srv/p"})
	fakeResticRestore = func(dir string) {
		// A share member swaps Restored for a symlink while restic runs.
		if err := os.Rename(filepath.Join(base, "Restored"), filepath.Join(base, "R2")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(base, "Restored")); err != nil {
			t.Fatal(err)
		}
		writeStaged(t, dir, "file", "data")
	}
	if err := runRestoreRequest(file); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(base, "R2", "x", "file")); err != nil || string(b) != "data" {
		t.Fatalf("file not in the original inode: %v", err)
	}
	if ents, _ := os.ReadDir(outside); len(ents) != 0 {
		t.Fatalf("redirected: %v", ents)
	}
	if st, _ := os.Stat(filepath.Join(base, "R2", "x")); st.Mode().Perm() != 0o755 {
		t.Fatalf("mode %v", st.Mode())
	}
	args := (*calls)[len(*calls)-1].args
	found := false
	for i, a := range args {
		if a == "--target" && args[i+1] == resticFdTarget {
			found = true
		}
	}
	if resticFdTarget != "/proc/self/fd/3/." || !found {
		t.Fatalf("target %v", args)
	}
}
func TestRestoreRequestForUnknownRepositoryIsRecorded(t *testing.T) {
	base := t.TempDir()
	file, _ := restoreFixture(t, restoreRequest{Mode: "new", Base: base, Name: "x", Path: filepath.Join(base, "p")})
	other := "33333333-3333-4333-8333-333333333333"
	raw, _ := os.ReadFile(file)
	var rr restoreRequest
	_ = json.Unmarshal(raw, &rr)
	rr.Repository = other
	file, _ = writeRestoreRequest(rr)
	if err := runRestoreRequest(file); err == nil {
		t.Fatal("unknown repository accepted")
	}
	runs, _ := lastRuns("restores", other, 5)
	if len(runs) != 1 || runs[0].Status != "failed" {
		t.Fatalf("%+v", runs)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("request file kept")
	}
}

func TestRepositoryInitStoresPasswordEvenIfConfigWriteFails(t *testing.T) {
	useUnits(t)
	fakeRestic(t, nil, map[string]int{"cat": 10})
	p := planFor(t, "backup.repository.save", map[string]any{"repository": sampleConfig().Repositories[0], "secrets": map[string]string{}})
	for i := range p.Steps {
		if p.Steps[i].Target == backupConfigPath() {
			p.Steps[i].run = func() (string, error) { return "", os.ErrPermission }
		}
		if strings.HasPrefix(p.Steps[i].Summary, "Store the repository secrets") {
			p.Steps[i].run = func() (string, error) { return "", os.ErrPermission }
		}
	}
	if _, ok, _ := p.execute(); ok {
		t.Fatal("expected failure")
	}
	pw, _ := p.Reply["password"].(string)
	s, err := readRepoSecrets(repoA)
	if err != nil || pw == "" || s.Password != pw {
		t.Fatalf("password lost: %v %q %+v", err, pw, s)
	}
}

func TestRepositoryLocationChangeIsProbed(t *testing.T) {
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "keep"})
	calls := fakeRestic(t, nil, map[string]int{"cat": 1})
	r := sampleConfig().Repositories[0]
	r.Path = "/srv/other/restic"
	_, ferr := buildPlan("backup.repository.save", mustJSON(map[string]any{"repository": r, "secrets": map[string]string{}}))
	if ferr == nil || ferr.Code != "EUNREACHABLE" {
		t.Fatalf("%+v", ferr)
	}
	if len(*calls) != 1 || envValue((*calls)[0].env, "RESTIC_PASSWORD") != "keep" {
		t.Fatalf("probe with the stored password expected: %v", *calls)
	}
}

func TestRestoreOriginalNeverTouchesOldStagingName(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	_ = os.MkdirAll(data, 0o755)
	runID := newRunID()
	// Another user's tree, planted where the old staging directory would have been.
	planted := filepath.Join(root, ".hsi-restore-"+runID)
	_ = os.MkdirAll(planted, 0o755)
	_ = os.WriteFile(filepath.Join(planted, "theirs"), []byte("x"), 0o644)
	file, _ := restoreFixture(t, restoreRequest{RunID: runID, Mode: "original", Base: root, Path: data})
	fakeResticRestore = func(dir string) { writeStaged(t, dir, data+"/f", "x") }
	if err := runRestoreRequest(file); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(planted, "theirs")); err != nil {
		t.Fatalf("a tree in Base was deleted: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(data, "f")); string(b) != "x" {
		t.Fatal("not merged")
	}
}

func TestCreateFreshDirRefusesSwappedEntry(t *testing.T) {
	for name, swap := range map[string]func(dir string){
		"other dir with content": func(dir string) {
			_ = os.Remove(dir)
			_ = os.Mkdir(dir, 0o700)
			_ = os.WriteFile(filepath.Join(dir, "theirs"), []byte("x"), 0o644)
		},
		"other mode":               func(dir string) { _ = os.Chmod(dir, 0o755) },
		"setuid bit":               func(dir string) { _ = os.Chmod(dir, 0o700|os.ModeSetuid) },
		"sticky bit":               func(dir string) { _ = os.Chmod(dir, 0o700|os.ModeSticky) },
		"setgid with group access": func(dir string) { _ = os.Chmod(dir, 0o770|os.ModeSetgid) },
		"symlink": func(dir string) {
			_ = os.Remove(dir)
			_ = os.Symlink(t.TempDir(), dir)
		},
	} {
		parent := t.TempDir()
		f, err := openDirNoFollow(parent)
		if err != nil {
			t.Fatal(err)
		}
		afterMkdirHook = func(_ *os.File, n string) { swap(filepath.Join(parent, n)) }
		_, _, err = createFreshDir(f, "x", true)
		afterMkdirHook = nil
		f.Close()
		if err == nil {
			t.Errorf("%s: swapped entry accepted", name)
		}
	}
}

func TestMergeIntoStaysInHeldDestination(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	dstPath, srcPath := filepath.Join(root, "dst"), filepath.Join(root, "src")
	_ = os.MkdirAll(filepath.Join(dstPath, "d"), 0o755)
	writeStaged(t, srcPath, "d/f", "new")
	writeStaged(t, srcPath, "created/g", "g")
	dst, _ := openDirNoFollow(dstPath)
	src, _ := openDirNoFollow(srcPath)
	defer dst.Close()
	defer src.Close()
	// The destination is renamed after its descriptor was opened, and a symlink takes its place.
	_ = os.Rename(dstPath, filepath.Join(root, "moved"))
	if err := os.Symlink(outside, dstPath); err != nil {
		t.Fatal(err)
	}
	var res mergeResult
	if err := mergeInto(src, dst, "", &res); err != nil {
		t.Fatal(err)
	}
	if ents, _ := os.ReadDir(outside); len(ents) != 0 {
		t.Fatalf("written outside: %v", ents)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "moved", "d", "f")); string(b) != "new" {
		t.Fatal("not merged into the held directory")
	}
	if _, err := os.Stat(filepath.Join(root, "moved", "created", "g")); err != nil {
		t.Fatal("missing directory not created")
	}
}

func TestMergeIntoSkipsEntryThatChangedType(t *testing.T) {
	root := t.TempDir()
	srcPath, dstPath := filepath.Join(root, "src"), filepath.Join(root, "dst")
	_ = os.MkdirAll(dstPath, 0o755)
	writeStaged(t, srcPath, "a", "x")
	writeStaged(t, srcPath, "b", "y")
	dst, _ := openDirNoFollow(dstPath)
	src, _ := openDirNoFollow(srcPath)
	defer dst.Close()
	defer src.Close()
	// "a" becomes a non-empty directory after the check, before the rename.
	beforeRenameHook = func(_ *os.File, name string) {
		if name == "a" {
			_ = os.MkdirAll(filepath.Join(dstPath, "a", "inner"), 0o755)
		}
	}
	t.Cleanup(func() { beforeRenameHook = nil })
	var res mergeResult
	if err := mergeInto(src, dst, "", &res); err != nil {
		t.Fatalf("merge aborted: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(dstPath, "b")); string(b) != "y" || res.moved != 1 || len(res.warnings) != 1 {
		t.Fatalf("%+v", res)
	}
}

func TestRestoreOriginalThroughVolumeMount(t *testing.T) {
	root := t.TempDir()
	mount := filepath.Join(root, "vol")
	data := filepath.Join(mount, "data")
	_ = os.MkdirAll(data, 0o755)
	prev := volumeMountFor
	volumeMountFor = func(string) string { return mount }
	t.Cleanup(func() { volumeMountFor = prev })
	file, _ := restoreFixture(t, restoreRequest{Mode: "original", Base: mount, Path: data})
	fakeResticRestore = func(dir string) { writeStaged(t, dir, data+"/f", "x") }
	if err := runRestoreRequest(file); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(data, "f")); string(b) != "x" {
		t.Fatal("not merged")
	}
	if ents, _ := os.ReadDir(filepath.Join(mount, "Restored")); len(ents) != 0 {
		t.Fatalf("staging left behind: %v", ents)
	}
	// "/" as the mount point must not leak or double close descriptors.
	f, _ := openDirNoFollow(root)
	d, err := descendDirs(f, "/")
	if err != nil {
		t.Fatal(err)
	}
	d.Close()
	f.Close()
}

// setgidDir returns a 2775 directory, the mode HSI gives share volumes. Linux then sets
// S_ISGID on every directory created below it, even by root.
func setgidDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o775|os.ModeSetgid); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode()&os.ModeSetgid == 0 {
		t.Skip("filesystem drops the setgid bit on directories")
	}
	return dir
}

func TestCreateFreshDirUnderSetgidParent(t *testing.T) {
	parent := setgidDir(t)
	f, err := openDirNoFollow(parent)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	d, _, err := createFreshDir(f, "x", true)
	if err != nil {
		t.Fatalf("fresh dir under a setgid parent refused: %v", err)
	}
	d.Close()
}

func TestRestoreNewUnderSetgidVolume(t *testing.T) {
	base := setgidDir(t)
	file, calls := restoreFixture(t, restoreRequest{Mode: "new", Base: base, Name: "x", Path: filepath.Join(base, "photos")})
	fakeResticRestore = func(dir string) { writeStaged(t, dir, "photos/a.jpg", "a") }
	if err := runRestoreRequest(file); err != nil {
		t.Fatal(err)
	}
	if got := restoreTargets(calls); len(got) != 1 || got[0] != filepath.Join(base, "Restored", "x") {
		t.Fatalf("targets %v", got)
	}
	if b, _ := os.ReadFile(filepath.Join(base, "Restored", "x", "photos", "a.jpg")); string(b) != "a" {
		t.Fatal("restored file missing")
	}
}

func TestRestoreOriginalUnderSetgidVolume(t *testing.T) {
	root := setgidDir(t)
	data := filepath.Join(root, "data")
	if err := os.Mkdir(data, 0o775); err != nil {
		t.Fatal(err)
	}
	file, _ := restoreFixture(t, restoreRequest{Mode: "original", Base: root, Path: data})
	fakeResticRestore = func(dir string) {
		writeStaged(t, dir, data+"/a.txt", "a")
		writeStaged(t, dir, data+"/sub/b.txt", "b")
	}
	if err := runRestoreRequest(file); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(data, "sub", "b.txt")); string(b) != "b" {
		t.Fatal("missing directory not created under the setgid volume")
	}
	runs, _ := lastRuns("restores", repoA, 1)
	if len(runs) != 1 || runs[0].Status != "success" || runs[0].Files != 2 || len(runs[0].Warnings) != 0 {
		t.Fatalf("%+v", runs)
	}
}

func TestMergeIntoCreatesDirUnderSetgidParent(t *testing.T) {
	dstPath, srcPath := setgidDir(t), t.TempDir()
	writeStaged(t, srcPath, "created/g", "g")
	dst, _ := openDirNoFollow(dstPath)
	src, _ := openDirNoFollow(srcPath)
	defer dst.Close()
	defer src.Close()
	var res mergeResult
	if err := mergeInto(src, dst, "", &res); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dstPath, "created", "g")); string(b) != "g" || len(res.warnings) != 0 {
		t.Fatalf("not created: %+v", res)
	}
}

func TestMergeIntoWarnsWhenCreatedDirIsReplaced(t *testing.T) {
	dstPath, srcPath := setgidDir(t), t.TempDir()
	writeStaged(t, srcPath, "created/g", "g")
	dst, _ := openDirNoFollow(dstPath)
	src, _ := openDirNoFollow(srcPath)
	defer dst.Close()
	defer src.Close()
	afterMkdirHook = func(_ *os.File, n string) {
		_ = os.WriteFile(filepath.Join(dstPath, n, "theirs"), []byte("x"), 0o644)
	}
	t.Cleanup(func() { afterMkdirHook = nil })
	var res mergeResult
	if err := mergeInto(src, dst, "", &res); err != nil {
		t.Fatal(err)
	}
	if len(res.warnings) != 1 || !strings.Contains(res.warnings[0], "was replaced") {
		t.Fatalf("%+v", res)
	}
	if _, err := os.Stat(filepath.Join(dstPath, "created", "g")); !os.IsNotExist(err) {
		t.Fatal("merged into a replaced directory")
	}
}
