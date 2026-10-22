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

// ── M1: where sources and local repositories may be ─────────────────────────

func TestPlanSaveRefusesSourceOffTheDataVolumes(t *testing.T) {
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	pl := sampleConfig().Plans[0]
	pl.Versions.Sources = []string{"/srv/data/photos", "/home/admin"}
	_, ferr := buildPlan("backup.plan.save", mustJSON(map[string]any{"plan": pl}))
	if ferr == nil || ferr.Code != "EINVALID" || !strings.Contains(ferr.Message, "/home/admin is not on a data volume") {
		t.Fatalf("%+v", ferr)
	}
}

func TestPlanSaveRefusesRepositoryAndSourceOverlap(t *testing.T) {
	useUnits(t)
	c := sampleConfig()
	c.Repositories[0].Path = "/srv/data/photos/restic"
	_ = saveBackupConfig(c)
	for _, sources := range [][]string{{"/srv/data/photos"}, {"/srv/data/photos/restic/data"}, {"/srv/data/photos/restic"}} {
		pl := c.Plans[0]
		pl.Versions.Sources = sources
		_, ferr := buildPlan("backup.plan.save", mustJSON(map[string]any{"plan": pl}))
		if ferr == nil || !strings.Contains(ferr.Message, "overlap") {
			t.Fatalf("%v: %+v", sources, ferr)
		}
	}
	pl := c.Plans[0]
	pl.Versions.Sources = []string{"/srv/data/photos2"}
	if _, ferr := buildPlan("backup.plan.save", mustJSON(map[string]any{"plan": pl})); ferr != nil {
		t.Fatalf("a sibling with a common prefix is no overlap: %+v", ferr)
	}
}

func TestRepositoryMovedIntoASourceIsRefused(t *testing.T) {
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "p"})
	calls := fakeRestic(t, nil, map[string]int{"cat": 10})
	r := sampleConfig().Repositories[0]
	r.Path = "/srv/data/photos/restic"
	_, ferr := buildPlan("backup.repository.save", mustJSON(map[string]any{"repository": r, "secrets": map[string]string{}}))
	if ferr == nil || !strings.Contains(ferr.Message, "overlap") || len(*calls) != 0 {
		t.Fatalf("%+v %v", ferr, *calls)
	}
}

// ── M2: retention survives a rename ─────────────────────────────────────────

func TestSnapshotsKeepOneHostAndOneRetentionGroup(t *testing.T) {
	useBackupDirs(t)
	calls := fakeRestic(t, map[string][]string{"backup": {summaryLine}}, nil)
	r, sec := repositoryCfg{Type: "local", Path: testRepoPath}, repoSecrets{Password: "p"}
	if _, err := resticBackup(r, sec, []string{"/srv/a"}, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	_ = resticForget(r, sec, "pid", retentionPolicy{KeepLast: 3})
	if b := strings.Join((*calls)[0].args, " "); !strings.Contains(b, "--host hsi") {
		t.Fatalf("backup %q", b)
	}
	forget := (*calls)[1].args
	for i, a := range forget {
		if a == "--group-by" {
			if forget[i+1] != "" {
				t.Fatalf("group by %q", forget[i+1])
			}
			return
		}
	}
	t.Fatalf("no --group-by in %q", forget)
}

// ── M3: an S3 endpoint may say http:// ──────────────────────────────────────

func TestS3EndpointScheme(t *testing.T) {
	for endpoint, want := range map[string]string{
		"s3.example.com":         "s3:https://s3.example.com/bkt",
		"https://s3.example.com": "s3:https://s3.example.com/bkt",
		"http://minio.lan:9000":  "s3:http://minio.lan:9000/bkt",
	} {
		r := repositoryCfg{ID: repoA, Name: "S3", Type: "s3", Endpoint: endpoint, Bucket: "bkt", Check: checkSchedule{Every: "off"}}
		if err := validateRepository(r); err != nil {
			t.Errorf("%s: %v", endpoint, err)
		}
		if got := resticRepository(r); got != want {
			t.Errorf("%s: %q", endpoint, got)
		}
	}
	for _, endpoint := range []string{"ftp://x.com", "http://", "https://x.com/path", "http://x.com:99999", "http:/x.com"} {
		r := repositoryCfg{ID: repoA, Name: "S3", Type: "s3", Endpoint: endpoint, Bucket: "bkt", Check: checkSchedule{Every: "off"}}
		if validateRepository(r) == nil {
			t.Errorf("%s accepted", endpoint)
		}
	}
}

// ── M4: a new location's password ───────────────────────────────────────────

func TestLocationChangeUsesTheGivenPassword(t *testing.T) {
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "old"})
	calls := fakeRestic(t, nil, map[string]int{"cat": 0})
	r := sampleConfig().Repositories[0]
	r.Path = filepath.Join(t.TempDir(), "other")
	_ = os.Mkdir(r.Path, 0o700)
	p := planFor(t, "backup.repository.save", map[string]any{"repository": r, "secrets": map[string]string{"password": "theirs"}})
	if envValue((*calls)[0].env, "RESTIC_PASSWORD") != "theirs" {
		t.Fatal("the probe must use the password given for the new location")
	}
	if _, ok, _ := p.execute(); !ok {
		t.Fatal("apply failed")
	}
	if s, _ := readRepoSecrets(repoA); s.Password != "theirs" {
		t.Fatalf("stored %q", s.Password)
	}
}

func TestLocationChangeAsksForThePasswordWhenBlank(t *testing.T) {
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "old"})
	fakeRestic(t, nil, map[string]int{"cat": 12})
	r := sampleConfig().Repositories[0]
	r.Path = filepath.Join(t.TempDir(), "other")
	_ = os.Mkdir(r.Path, 0o700)
	_, ferr := buildPlan("backup.repository.save", mustJSON(map[string]any{"repository": r, "secrets": map[string]string{}}))
	if ferr == nil || ferr.Code != "EPASSWORD" || ferr.Message != msgRepositoryExists {
		t.Fatalf("%+v", ferr)
	}
}

func TestSameLocationKeepsTheStoredPassword(t *testing.T) {
	useUnits(t)
	_ = saveBackupConfig(sampleConfig())
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "keep"})
	fakeRestic(t, nil, nil)
	p := planFor(t, "backup.repository.save", map[string]any{"repository": sampleConfig().Repositories[0], "secrets": map[string]string{"password": "typo"}})
	if _, ok, _ := p.execute(); !ok {
		t.Fatal("apply failed")
	}
	if s, _ := readRepoSecrets(repoA); s.Password != "keep" {
		t.Fatalf("stored %q", s.Password)
	}
}

// ── M6: the command line never remounts a volume ───────────────────────────

func TestBackupVolumeCheckNeverRemounts(t *testing.T) {
	dir := t.TempDir()
	fstab := filepath.Join(dir, "fstab")
	conf := hsiMountMarker + "/srv/data\nUUID=1234-abcd /srv/data ext4 defaults,nofail 0 2\n"
	if err := os.WriteFile(fstab, []byte(conf), 0o644); err != nil {
		t.Fatal(err)
	}
	prevFstab, prevFind, prevBlkid := fstabPath, findmntAt, blkidPresent
	fstabPath = fstab
	findmntAt = func(string) string { return "" }
	blkidPresent = func(string) bool { t.Error("the volume guard's remount path was reached"); return true }
	t.Cleanup(func() { fstabPath, findmntAt, blkidPresent = prevFstab, prevFind, prevBlkid })
	if err := volumeAvailable("/srv/data/photos"); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("%v", err)
	}
	if got := volumeMountFor("/srv/data/photos"); got != "/srv/data" {
		t.Fatalf("mount %q", got)
	}
	findmntAt = func(string) string { return `UUID="1234-abcd" OPTIONS="rw,relatime"` }
	if err := volumeAvailable("/srv/data/photos"); err != nil {
		t.Fatal(err)
	}
	// /srv/data does not hold /srv/data2.
	findmntAt = func(string) string { return "" }
	if err := volumeAvailable("/srv/data2/x"); err != nil {
		t.Fatalf("prefix match: %v", err)
	}
}

// ── M8: a "%" in a name ─────────────────────────────────────────────────────

func TestTimerDescriptionEscapesSpecifiers(t *testing.T) {
	p := sampleConfig().Plans[0]
	p.Name = "100% photos %n"
	if u := planTimerUnit(p); !strings.Contains(u, "Description=HSI backup plan 100%% photos %%n\n") {
		t.Fatalf("%s", u)
	}
}

// ── Task 1 ──────────────────────────────────────────────────────────────────

func TestSyncPlanValidation(t *testing.T) {
	good := syncOptions{Direction: "push", Source: "/srv/a", Destination: "/srv/b"}
	if err := validateSync(good); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*syncOptions){
		"direction":         func(o *syncOptions) { o.Direction = "both" },
		"relative source":   func(o *syncOptions) { o.Source = "a" },
		"overlap":           func(o *syncOptions) { o.Destination = "/srv/a/sub" },
		"same":              func(o *syncOptions) { o.Destination = "/srv/a" },
		"user without host": func(o *syncOptions) { o.RemoteUser = "nas" },
		"bad host": func(o *syncOptions) {
			o.RemoteHost, o.RemoteUser, o.RemotePort, o.SSHKeyPath = "-oProxy", "nas", 22, "/root/k"
		},
		"bad port": func(o *syncOptions) {
			o.RemoteHost, o.RemoteUser, o.RemotePort, o.SSHKeyPath = "nas.lan", "nas", 0, "/root/k"
		},
		"no key":    func(o *syncOptions) { o.RemoteHost, o.RemoteUser, o.RemotePort = "nas.lan", "nas", 22 },
		"bandwidth": func(o *syncOptions) { o.BandwidthLimit = -1 },
		"exclude":   func(o *syncOptions) { o.Excludes = []string{"a\nb"} },
	} {
		o := good
		mutate(&o)
		if validateSync(o) == nil {
			t.Errorf("%s accepted", name)
		}
	}
	remote := good
	remote.RemoteHost, remote.RemoteUser, remote.RemotePort, remote.SSHKeyPath = "nas.lan", "nas", 22, "/root/.ssh/id_ed25519"
	remote.Destination = "/srv/a"
	if err := validateSync(remote); err != nil {
		t.Fatalf("a remote destination may share the local path: %v", err)
	}
}

func TestMonthlyCheckNeedsADay(t *testing.T) {
	k := checkSchedule{Every: "monthly", Hour: 4, Day: 0, Subset: "5%"}
	if validateCheck(k) == nil {
		t.Fatal("monthly check on day 0 accepted")
	}
	k.Day = 28
	if err := validateCheck(k); err != nil {
		t.Fatal(err)
	}
	k.Day = 29
	if validateCheck(k) == nil {
		t.Fatal("day 29 accepted")
	}
}

func TestInvalidBackupConfigIsReported(t *testing.T) {
	useBackupDirs(t)
	_ = os.WriteFile(backupConfigPath(), []byte("{"), 0o644)
	if _, exists, err := loadBackupConfig(); err == nil || !exists {
		t.Fatalf("%v %v", exists, err)
	}
}

func TestS3PrefixRefusesParent(t *testing.T) {
	for _, prefix := range []string{"..", "a/../b", "/abs", "a\nb"} {
		r := repositoryCfg{ID: repoA, Name: "S3", Type: "s3", Endpoint: "s3.example.com", Bucket: "bkt", Path: prefix, Check: checkSchedule{Every: "off"}}
		if validateRepository(r) == nil {
			t.Errorf("%q accepted", prefix)
		}
	}
}

func TestSecretsDirModeIsTightened(t *testing.T) {
	useBackupDirs(t)
	if err := os.MkdirAll(backupSecretsDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeRepoSecrets(repoA, repoSecrets{Password: "p"}); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(backupSecretsDir()); st.Mode().Perm() != 0o700 {
		t.Fatalf("mode %v", st.Mode())
	}
}

func TestWriteBackupFileReplacesAtomically(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f")
	if err := writeBackupFile(path, []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeBackupFile(path, []byte("two"), 0o644); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	st, _ := os.Stat(path)
	if string(b) != "two" || st.Mode().Perm() != 0o644 || fileExists(path+".tmp") {
		t.Fatalf("%q %v", b, st.Mode())
	}
}

// ── Task 2 ──────────────────────────────────────────────────────────────────

func TestResticVersionFromTheBinary(t *testing.T) {
	useBackupDirs(t)
	t.Setenv("HSI_RESTIC", filepath.Join(t.TempDir(), "absent"))
	if _, ok := resticVersion(); ok {
		t.Fatal("version of a missing binary")
	}
	stub := filepath.Join(t.TempDir(), "restic")
	_ = os.WriteFile(stub, []byte("#!/bin/sh\n[ \"$1 $2\" = \"version --json\" ] || exit 2\necho '{\"version\":\"0.19.1\",\"go_version\":\"go1.24\"}'\n"), 0o755)
	t.Setenv("HSI_RESTIC", stub)
	if v, ok := resticVersion(); !ok || v != "0.19.1" {
		t.Fatalf("%q %v", v, ok)
	}
}

func TestRealResticGetsEnvNotArgsAndATrimmedStderr(t *testing.T) {
	useBackupDirs(t)
	stub := filepath.Join(t.TempDir(), "restic")
	_ = os.WriteFile(stub, []byte("#!/bin/sh\necho \"$RESTIC_PASSWORD|$HOME\"\nhead -c 10000 /dev/zero | tr '\\0' e >&2\necho END >&2\nexit 4\n"), 0o755)
	t.Setenv("HSI_RESTIC", stub)
	var line string
	code, stderr, err := runRestic([]string{"RESTIC_PASSWORD=pw"}, []string{"cat", "config"}, func(b []byte) { line = string(b) })
	if err != nil || code != 4 {
		t.Fatalf("%d %v", code, err)
	}
	if line != "pw|"+backupStateDir() {
		t.Fatalf("env %q", line)
	}
	if len(stderr) != resticStderrTail || !strings.HasSuffix(stderr, "END\n") {
		t.Fatalf("stderr %d bytes", len(stderr))
	}
}

func TestSnapshotsParseAndInitArgs(t *testing.T) {
	useBackupDirs(t)
	calls := fakeRestic(t, map[string][]string{"snapshots": {`[{"id":"abc","short_id":"ab","time":"2026-01-02T03:04:05Z","paths":["/srv/a"],"tags":["hsi"]}]`}}, nil)
	r, sec := repositoryCfg{Type: "local", Path: testRepoPath}, repoSecrets{Password: "p"}
	list, err := resticSnapshots(r, sec)
	if err != nil || len(list) != 1 || list[0].ShortID != "ab" || list[0].Paths[0] != "/srv/a" || list[0].Time.Year() != 2026 {
		t.Fatalf("%+v %v", list, err)
	}
	if err := resticInit(r, sec); err != nil {
		t.Fatal(err)
	}
	if got := (*calls)[1].args; got[0] != "init" || envValue((*calls)[1].env, "RESTIC_REPOSITORY") != "/proc/self/fd/3/." {
		t.Fatalf("%v", got)
	}
	fakeRestic(t, nil, map[string]int{"snapshots": 1})
	if _, err := resticSnapshots(r, sec); err == nil {
		t.Fatal("failure not reported")
	}
}

func TestLsRefusesARelativeDir(t *testing.T) {
	useBackupDirs(t)
	calls := fakeRestic(t, nil, nil)
	if _, err := resticLs(repositoryCfg{Type: "local", Path: testRepoPath}, repoSecrets{Password: "p"}, "s", ""); err == nil || len(*calls) != 0 {
		t.Fatalf("%v %v", err, *calls)
	}
}

func TestTailBufferKeepsTheEnd(t *testing.T) {
	b := &tailBuffer{max: 4}
	_, _ = b.Write([]byte("abc"))
	_, _ = b.Write([]byte("defgh"))
	if string(b.buf) != "efgh" {
		t.Fatalf("%q", b.buf)
	}
}

// ── Task 3 ──────────────────────────────────────────────────────────────────

func TestUnknownAppStateIsInconsistentAndUntouched(t *testing.T) {
	setupVersionsPlan(t, "vaultwarden")
	f := &appsFake{}
	fakeApps(t, f)
	composeRunning = func(string) (bool, error) { return false, errors.New("docker: cannot connect") }
	calls := fakeRestic(t, map[string][]string{"backup": {summaryLine}}, nil)
	if err := runPlan(planA, false, time.Now); err != nil {
		t.Fatal(err)
	}
	if len(f.calls) != 0 {
		t.Fatalf("app touched: %v", f.calls)
	}
	if !strings.Contains(strings.Join((*calls)[0].args, " "), "--tag inconsistent") {
		t.Fatal("not tagged inconsistent")
	}
	runs, _ := lastRuns("runs", planA, 1)
	if runs[0].Consistent == nil || *runs[0].Consistent || !strings.Contains(strings.Join(runs[0].Warnings, ";"), "could not tell whether vaultwarden is running") {
		t.Fatalf("%+v", runs[0])
	}
}

func TestSyncPlanRun(t *testing.T) {
	useBackupDirs(t)
	src, dst := t.TempDir(), t.TempDir()
	_ = os.WriteFile(filepath.Join(src, "a"), []byte("x"), 0o644)
	c := backupConfig{Plans: []backupPlanCfg{{ID: planA, Name: "Sync", Type: "sync", Enabled: true, Schedule: backupSchedule{Every: "manual"},
		Sync: &syncOptions{Direction: "push", Source: src, Destination: dst}}}}
	_ = saveBackupConfig(c)
	var checked []string
	prev := volumeAvailable
	volumeAvailable = func(p string) error { checked = append(checked, p); return nil }
	t.Cleanup(func() { volumeAvailable = prev })
	if _, err := os.Stat("/usr/bin/rsync"); err != nil {
		t.Skip("rsync not installed")
	}
	if err := runPlan(planA, false, time.Now); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "a")); string(b) != "x" || len(checked) != 2 {
		t.Fatalf("%q %v", b, checked)
	}
	volumeAvailable = func(p string) error { return errors.New(p + ": missing") }
	if err := runPlan(planA, false, time.Now); err == nil {
		t.Fatal("ran on a missing volume")
	}
	runs, _ := lastRuns("runs", planA, 2)
	if runs[0].Status != "failed" || runs[1].Status != "success" {
		t.Fatalf("%+v", runs)
	}
}

func TestBackupCLIParsing(t *testing.T) {
	setupVersionsPlan(t)
	calls := fakeRestic(t, nil, nil)
	for _, args := range [][]string{{}, {"run"}, {"run", "../x"}, {"run", planA, "extra"}, {"run", planA, "--bogus"},
		{"check", "-x"}, {"check", repoA, "--full", "extra"}, {"restore", "a", "b"}, {"nope", planA}} {
		if code := runBackupCLI(args); code == 0 {
			t.Errorf("%v accepted", args)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("restic reached: %v", *calls)
	}
	if code := runBackupCLI([]string{"check", repoA, "--full"}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if a := strings.Join((*calls)[0].args, " "); !strings.Contains(a, "--read-data") || strings.Contains(a, "--read-data-subset") {
		t.Fatalf("full check %q", a)
	}
	_ = runBackupCLI([]string{"check", repoA})
	if a := strings.Join((*calls)[1].args, " "); !strings.Contains(a, "--read-data-subset 5%") {
		t.Fatalf("check %q", a)
	}
}

// ── Task 4 ──────────────────────────────────────────────────────────────────

func TestRepositoryRemoveWaitsForACheckOrRestore(t *testing.T) {
	useUnits(t)
	c := sampleConfig()
	c.Plans = nil
	_ = saveBackupConfig(c)
	held := make(chan struct{})
	done := make(chan struct{})
	go func() {
		_ = withLock(repoA, time.Second, func() error { close(held); <-done; return nil })
	}()
	<-held
	_, ferr := buildPlan("backup.repository.remove", mustJSON(map[string]any{"id": repoA}))
	close(done)
	if ferr == nil || ferr.Code != "EBUSY" {
		t.Fatalf("%+v", ferr)
	}
}

func TestParseElapse(t *testing.T) {
	paris, err := time.LoadLocation("Europe/Paris")
	if err != nil {
		t.Skip("no time zone data")
	}
	// 02:30 happens twice on 2026-10-25 in Paris: the zone name tells which.
	summer := parseElapse("Sun 2026-10-25 02:30:00 CEST", paris)
	winter := parseElapse("Sun 2026-10-25 02:30:00 CET", paris)
	if summer == nil || winter == nil || winter.Sub(*summer) != time.Hour {
		t.Fatalf("%v %v", summer, winter)
	}
	if got := parseElapse("Tue 2026-10-20 02:30:00 UTC", paris); got == nil || !got.Equal(time.Date(2026, 10, 20, 2, 30, 0, 0, time.UTC)) {
		t.Fatalf("%v", got)
	}
	if got := parseElapse("Tue 2026-10-20 02:30:00", paris); got == nil || got.Hour() != 2 {
		t.Fatalf("%v", got)
	}
	for _, s := range []string{"", "n/a", "soon"} {
		if parseElapse(s, paris) != nil {
			t.Errorf("%q parsed", s)
		}
	}
}

func TestNextElapseAsksSystemd(t *testing.T) {
	calls := useUnits(t)
	systemctl = func(args ...string) ([]byte, error) {
		*calls = append(*calls, strings.Join(args, " "))
		return []byte("Tue 2026-10-20 02:30:00 UTC\n"), nil
	}
	if got := nextElapse("hsi-backup@x.timer"); got == nil || got.UTC().Hour() != 2 {
		t.Fatalf("%v", got)
	}
	if (*calls)[0] != "show -p NextElapseUSecRealtime --value hsi-backup@x.timer" {
		t.Fatalf("%v", *calls)
	}
}

func TestRetryAfterAFailedApplyAttachesWithTheStoredPassword(t *testing.T) {
	useUnits(t)
	// The init succeeded and stored the password, then backup.json failed to save.
	_ = writeRepoSecrets(repoA, repoSecrets{Password: "generated"})
	calls := fakeRestic(t, nil, map[string]int{"cat": 0})
	p := planFor(t, "backup.repository.save", map[string]any{"repository": sampleConfig().Repositories[0], "secrets": map[string]string{}})
	if envValue((*calls)[0].env, "RESTIC_PASSWORD") != "generated" {
		t.Fatal("probe without the stored password")
	}
	if _, ok, _ := p.execute(); !ok {
		t.Fatal("apply failed")
	}
}

func TestOriginalRestoreOffTheDataVolumesIsRefused(t *testing.T) {
	restorePreviewFixture(t, `{"message_type":"summary","files_restored":1,"total_files":1}`, lsNode("/home/admin/notes", "file"))
	in := map[string]any{"repository": repoA, "snapshot": "abcdef12", "path": "/home/admin/notes", "target": "original", "confirmOverwrite": true}
	if _, ferr := buildPlan("backup.restore", mustJSON(in)); ferr == nil || ferr.Code != "EINVALID" || !strings.Contains(ferr.Message, "data volume") {
		t.Fatalf("%+v", ferr)
	}
	in["target"] = "new"
	if _, ferr := buildPlan("backup.restore", mustJSON(in)); ferr != nil {
		t.Fatalf("a new folder stays possible: %+v", ferr)
	}
}

func TestMergeIntoSkipsAnotherFilesystem(t *testing.T) {
	root := t.TempDir()
	srcPath, dstPath := filepath.Join(root, "src"), filepath.Join(root, "dst")
	_ = os.MkdirAll(dstPath, 0o755)
	writeStaged(t, srcPath, "a", "x")
	writeStaged(t, srcPath, "b", "y")
	dst, _ := openDirNoFollow(dstPath)
	src, _ := openDirNoFollow(srcPath)
	defer dst.Close()
	defer src.Close()
	prev := renameat
	renameat = func(olddirfd int, oldpath string, newdirfd int, newpath string) error {
		if oldpath == "a" {
			return syscall.EXDEV
		}
		return prev(olddirfd, oldpath, newdirfd, newpath)
	}
	t.Cleanup(func() { renameat = prev })
	var res mergeResult
	if err := mergeInto(src, dst, "", &res); err != nil {
		t.Fatalf("merge aborted: %v", err)
	}
	if res.moved != 1 || len(res.warnings) != 1 || !strings.Contains(res.warnings[0], "/a is on another volume") {
		t.Fatalf("%+v", res)
	}
}

func TestFailedRestoreLeavesNoEmptyFolder(t *testing.T) {
	base := t.TempDir()
	file, _ := restoreFixture(t, restoreRequest{Mode: "new", Base: base, Name: "x", Path: filepath.Join(base, "photos")})
	fakeRestic(t, nil, map[string]int{"restore": 1})
	if err := runRestoreRequest(file); err == nil {
		t.Fatal("expected failure")
	}
	if ents, _ := os.ReadDir(filepath.Join(base, "Restored")); len(ents) != 0 {
		t.Fatalf("left behind: %v", ents)
	}
	runs, _ := lastRuns("restores", repoA, 1)
	if runs[0].Status != "failed" || runs[0].Target != "" {
		t.Fatalf("%+v", runs[0])
	}
}

func TestRestoreStatusTellsQueuedFromUnknown(t *testing.T) {
	useUnits(t)
	run := newRunID()
	if _, err := writeRestoreRequest(restoreRequest{RunID: run, Repository: repoA}); err != nil {
		t.Fatal(err)
	}
	if out := backupRestoreStatus(run); out["progress"] == nil {
		t.Fatalf("queued restore not reported: %+v", out)
	}
	old := time.Now().Add(-time.Hour)
	_ = os.Chtimes(filepath.Join(backupStateDir(), "restores", run+".json"), old, old)
	if out := backupRestoreStatus(run); out["progress"] != nil || out["result"] != nil {
		t.Fatalf("a request no unit picked up is not queued forever: %+v", out)
	}
}

// ── Task 5 ──────────────────────────────────────────────────────────────────

func TestNewTimersAreWrittenBeforeStaleOnesGo(t *testing.T) {
	useUnits(t)
	stale := filepath.Join(systemdDir(), checkTimerName(repoA))
	_ = os.WriteFile(stale, []byte("x"), 0o644)
	// The new timer cannot be written: a directory is in its way.
	_ = os.Mkdir(filepath.Join(systemdDir(), planTimerName(planA)), 0o755)
	c := sampleConfig()
	c.Repositories[0].Check.Every = "off"
	if err := writeAllTimers(c, false); err == nil {
		t.Fatal("expected failure")
	}
	if !fileExists(stale) {
		t.Fatal("a stale timer was removed although the new ones were not written")
	}
}

func TestHsiEnvArgsKeepsPathsAndDropsCredentials(t *testing.T) {
	got := strings.Join(hsiEnvArgs([]string{"HSI_BACKUP_SECRETS=/etc/x/backup", "HSI_SECRETS_KEY=abc", "HSI_API_TOKEN=t", "NATS_PASS=p", "HSI_BACKUP_STATE=/var/lib/x"}), " ")
	if got != "--setenv=HSI_BACKUP_SECRETS=/etc/x/backup --setenv=HSI_BACKUP_STATE=/var/lib/x" {
		t.Fatalf("%s", got)
	}
}

func TestMigrationRepliesSkippedPlans(t *testing.T) {
	useUnits(t)
	bad := map[string]any{"id": "nope", "name": "Bad"}
	_, skipped, _ := migrateRsyncPlans([]map[string]any{bad})
	raw, _ := json.Marshal(skipped)
	if !strings.Contains(string(raw), "invalid plan id") {
		t.Fatalf("%s", raw)
	}
}
