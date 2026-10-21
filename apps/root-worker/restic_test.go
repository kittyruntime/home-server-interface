package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type resticCall struct {
	env   []string
	args  []string
	extra []string // where each descriptor handed to restic points
}

// fakeResticRestore, when set, runs for each restore with the directory restic would write to.
var fakeResticRestore func(dir string)

// fakeRestic records calls and replays stdout lines and an exit code per subcommand.
func fakeRestic(t *testing.T, out map[string][]string, codes map[string]int) *[]resticCall {
	t.Helper()
	calls := &[]resticCall{}
	prev := runRestic
	fake := func(env, args []string, extra []*os.File, onLine func([]byte)) (int, string, error) {
		call := resticCall{env: env, args: args}
		dir := ""
		for i, f := range extra {
			link, _ := os.Readlink("/proc/self/fd/" + strconv.Itoa(int(f.Fd())))
			call.extra = append(call.extra, link)
			// The fake runs in this process: fd 3 of the child is this file.
			if i == 0 {
				dir = "/proc/self/fd/" + strconv.Itoa(int(f.Fd()))
			}
		}
		*calls = append(*calls, call)
		sub := ""
		for _, a := range args {
			if !strings.HasPrefix(a, "-") && !strings.Contains(a, "=") && a != "" {
				sub = a
				break
			}
		}
		if sub == "restore" && fakeResticRestore != nil && dir != "" {
			fakeResticRestore(dir)
		}
		for _, l := range out[sub] {
			if onLine != nil {
				onLine([]byte(l))
			}
		}
		return codes[sub], "stderr " + sub, nil
	}
	prevFiles := runResticFiles
	runRestic = func(env, args []string, onLine func([]byte)) (int, string, error) {
		return fake(env, args, nil, onLine)
	}
	runResticFiles = fake
	t.Cleanup(func() { runResticFiles = prevFiles; fakeResticRestore = nil })
	t.Cleanup(func() { runRestic = prev })
	return calls
}

func envValue(env []string, k string) string {
	for _, e := range env {
		if strings.HasPrefix(e, k+"=") {
			return strings.TrimPrefix(e, k+"=")
		}
	}
	return ""
}

func TestResticEnvPerType(t *testing.T) {
	sec := repoSecrets{Password: "pw", SSHKeyPath: "/etc/hsi/backup/k", AccessKeyID: "AK", SecretAccessKey: "SK", RestUser: "u", RestPassword: "rp"}
	cases := []struct {
		r    repositoryCfg
		repo string
	}{
		{repositoryCfg{Type: "local", Path: "/srv/usb/restic"}, "/srv/usb/restic"},
		{repositoryCfg{Type: "sftp", User: "nas", Host: "backup.lan", Port: 2222, Path: "/data/restic"}, "sftp://nas@backup.lan:2222//data/restic"},
		{repositoryCfg{Type: "s3", Endpoint: "s3.eu.example.com", Bucket: "hsi", Path: "home"}, "s3:https://s3.eu.example.com/hsi/home"},
		{repositoryCfg{Type: "rest", URL: "https://nas2.lan:8000/hsi/"}, "rest:https://nas2.lan:8000/hsi/"},
	}
	for _, c := range cases {
		env := resticEnv(c.r, sec)
		if got := envValue(env, "RESTIC_REPOSITORY"); got != c.repo {
			t.Errorf("%s: %q", c.r.Type, got)
		}
		if envValue(env, "RESTIC_PASSWORD") != "pw" {
			t.Errorf("%s: no password", c.r.Type)
		}
	}
	s3 := resticEnv(cases[2].r, sec)
	if envValue(s3, "AWS_ACCESS_KEY_ID") != "AK" || envValue(s3, "AWS_SECRET_ACCESS_KEY") != "SK" {
		t.Error("s3 keys")
	}
	if envValue(resticEnv(cases[0].r, sec), "AWS_ACCESS_KEY_ID") != "" {
		t.Error("s3 keys leaked into a local repository env")
	}
	rest := resticEnv(cases[3].r, sec)
	if envValue(rest, "RESTIC_REST_USERNAME") != "u" || envValue(rest, "RESTIC_REST_PASSWORD") != "rp" {
		t.Error("rest credentials")
	}
	ga, _ := resticGlobalArgs(cases[1].r, sec)
	g := strings.Join(ga, " ")
	if !strings.Contains(g, "sftp.args=-i /etc/hsi/backup/k") || !strings.Contains(g, "BatchMode=yes") {
		t.Errorf("sftp args %q", g)
	}
}

func TestResticSecretsNeverInArgs(t *testing.T) {
	useBackupDirs(t)
	calls := fakeRestic(t, nil, nil)
	r := repositoryCfg{Type: "s3", Endpoint: "e.com", Bucket: "bkt"}
	sec := repoSecrets{Password: "SUPERSECRET", AccessKeyID: "AKID", SecretAccessKey: "SKEY"}
	_, _ = resticBackup(r, sec, []string{"/srv/a"}, nil, []string{"hsi"}, nil)
	_ = resticCheck(r, sec, "5%")
	for _, c := range *calls {
		joined := strings.Join(c.args, " ")
		for _, s := range []string{"SUPERSECRET", "AKID", "SKEY"} {
			if strings.Contains(joined, s) {
				t.Fatalf("secret %s in args %q", s, joined)
			}
		}
	}
}

func TestProbeStates(t *testing.T) {
	useBackupDirs(t)
	r := repositoryCfg{Type: "local", Path: testRepoPath}
	for code, want := range map[int]probeState{0: "repository", 10: "empty", 12: "wrongPassword", 1: "unreachable"} {
		fakeRestic(t, nil, map[string]int{"cat": code})
		if got, _ := resticProbe(r, repoSecrets{Password: "p"}); got != want {
			t.Errorf("code %d: %s, want %s", code, got, want)
		}
	}
}

func TestBackupParsesSummaryAndProgress(t *testing.T) {
	useBackupDirs(t)
	fakeRestic(t, map[string][]string{"backup": {
		`{"message_type":"status","percent_done":0.5,"files_done":5,"total_files":10,"bytes_done":50,"total_bytes":100}`,
		`{"message_type":"summary","snapshot_id":"abc123","files_new":2,"files_changed":1,"files_unmodified":7,"data_added":4096}`,
	}}, nil)
	var seen []backupProgress
	sum, err := resticBackup(repositoryCfg{Type: "local", Path: testRepoPath}, repoSecrets{Password: "p"}, []string{"/srv/a"}, []string{"*.tmp"}, []string{"hsi", "plan:x"}, func(p backupProgress) { seen = append(seen, p) })
	if err != nil || sum.SnapshotID != "abc123" || sum.DataAdded != 4096 || sum.FilesNew != 2 {
		t.Fatalf("%+v %v", sum, err)
	}
	if len(seen) != 1 || seen[0].PercentDone != 0.5 {
		t.Fatalf("progress %+v", seen)
	}
}

func TestBackupExitThreeIsPartial(t *testing.T) {
	useBackupDirs(t)
	fakeRestic(t, map[string][]string{"backup": {
		`{"message_type":"error","error":{"message":"open /srv/a/x: permission denied"},"during":"archival","item":"/srv/a/x"}`,
		`{"message_type":"summary","snapshot_id":"def","files_new":1}`,
	}}, map[string]int{"backup": 3})
	sum, err := resticBackup(repositoryCfg{Type: "local", Path: testRepoPath}, repoSecrets{Password: "p"}, []string{"/srv/a"}, nil, nil, nil)
	if err != nil || !sum.Partial || sum.SnapshotID != "def" || !strings.Contains(sum.Warning, "/srv/a/x") {
		t.Fatalf("%+v %v", sum, err)
	}
}

func TestBackupFailureCarriesStderr(t *testing.T) {
	useBackupDirs(t)
	fakeRestic(t, nil, map[string]int{"backup": 1})
	if _, err := resticBackup(repositoryCfg{Type: "local", Path: testRepoPath}, repoSecrets{Password: "p"}, []string{"/srv/a"}, nil, nil, nil); err == nil || !strings.Contains(err.Error(), "stderr backup") {
		t.Fatalf("%v", err)
	}
}

func TestForgetArgs(t *testing.T) {
	useBackupDirs(t)
	calls := fakeRestic(t, nil, nil)
	_ = resticForget(repositoryCfg{Type: "local", Path: testRepoPath}, repoSecrets{Password: "p"}, "pid", retentionPolicy{KeepDaily: 7, KeepMonthly: 6})
	a := strings.Join((*calls)[0].args, " ")
	for _, want := range []string{"forget", "--prune", "--tag plan:pid", "--keep-daily 7", "--keep-monthly 6"} {
		if !strings.Contains(a, want) {
			t.Errorf("missing %q in %q", want, a)
		}
	}
	if strings.Contains(a, "--keep-last") {
		t.Errorf("zero keep-last passed: %q", a)
	}
}

func TestLsKeepsDirectChildren(t *testing.T) {
	useBackupDirs(t)
	fakeRestic(t, map[string][]string{"ls": {
		`{"struct_type":"snapshot","id":"s"}`,
		`{"struct_type":"node","name":"photos","path":"/srv/a/photos","type":"dir"}`,
		`{"struct_type":"node","name":"x.jpg","path":"/srv/a/photos/x.jpg","type":"file","size":3}`,
		`{"struct_type":"node","name":"a.txt","path":"/srv/a/a.txt","type":"file","size":1}`,
	}}, nil)
	got, err := resticLs(repositoryCfg{Type: "local", Path: testRepoPath}, repoSecrets{Password: "p"}, "s", "/srv/a")
	if err != nil || len(got) != 2 || got[0].Name != "photos" {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestRestoreDryRunArgs(t *testing.T) {
	useBackupDirs(t)
	calls := fakeRestic(t, map[string][]string{"restore": {`{"message_type":"summary","files_restored":4,"files_skipped":1,"total_files":5}`}}, nil)
	sum, err := resticRestore(repositoryCfg{Type: "local", Path: testRepoPath}, repoSecrets{Password: "p"}, "s1", "/srv/a/photos", "/srv/a/Restored/x", true, nil)
	if err != nil || sum.FilesRestored != 4 {
		t.Fatalf("%+v %v", sum, err)
	}
	a := strings.Join((*calls)[0].args, " ")
	for _, want := range []string{"restore s1", "--target /srv/a/Restored/x", "--include /srv/a/photos", "--dry-run", "--json"} {
		if !strings.Contains(a, want) {
			t.Errorf("missing %q in %q", want, a)
		}
	}
	if strings.Contains(a, "--delete") {
		t.Error("restore must never delete")
	}
}

func TestRunResticDeliversVeryLongLines(t *testing.T) {
	useBackupDirs(t)
	stub := filepath.Join(t.TempDir(), "restic")
	script := "#!/bin/sh\nhead -c 2000000 /dev/zero | tr '\\0' a\necho\necho second\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HSI_RESTIC", stub)
	var lines []int
	code, _, err := runRestic(nil, []string{"snapshots"}, func(b []byte) { lines = append(lines, len(b)) })
	if err != nil || code != 0 {
		t.Fatalf("%d %v", code, err)
	}
	if len(lines) != 2 || lines[0] != 2000000 || lines[1] != len("second") {
		t.Fatalf("lines %v", lines)
	}
}

func TestRestoreProgressUsesRestoredCounters(t *testing.T) {
	useBackupDirs(t)
	fakeRestic(t, map[string][]string{"restore": {
		`{"message_type":"status","percent_done":0.4,"total_files":10,"files_restored":4,"total_bytes":100,"bytes_restored":40}`,
		`{"message_type":"summary","files_restored":10,"total_files":10}`,
	}}, nil)
	var seen []backupProgress
	_, err := resticRestore(repositoryCfg{Type: "local", Path: testRepoPath}, repoSecrets{Password: "p"}, "s1", "/a", "/t", false, func(p backupProgress) { seen = append(seen, p) })
	if err != nil || len(seen) != 1 || seen[0].FilesDone != 4 || seen[0].BytesDone != 40 || seen[0].TotalFiles != 10 {
		t.Fatalf("%+v %v", seen, err)
	}
}
