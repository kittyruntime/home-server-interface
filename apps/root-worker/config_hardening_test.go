package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A symlink planted in the staging directory must not make the worker read
// or write outside it (review I7).
func TestStagingSymlinksRefused(t *testing.T) {
	dir := stubBackupHost(t)
	link := filepath.Join(backupStagingDir(), "evil")
	if err := os.Symlink("/etc", link); err != nil {
		t.Fatal(err)
	}
	if inStaging(filepath.Join(link, "cron.d")) {
		t.Fatal("a path through a symlink is not in staging")
	}
	// database.db as a symlink to a root-only file.
	_ = os.Remove(filepath.Join(dir, "database.db"))
	_ = os.Symlink("/etc/hostname", filepath.Join(dir, "database.db"))
	if err := buildBackupTar(dir, nil, "1.65.0", time.Now()); err == nil {
		t.Fatal("a staged symlink is not read")
	}
}

// A failed unpack leaves nothing behind (review I1).
func TestUnpackFailureCleansUp(t *testing.T) {
	stubBackupHost(t)
	dest := unpackDest(t)
	if _, err := unpackBackupTar(writeTar(t, map[string]string{"database.db": "x"}), dest); err == nil {
		t.Fatal("no manifest")
	}
	if fileExists(dest) {
		t.Fatal("the destination is removed after a failure")
	}
}

func TestUnpackCapsEntries(t *testing.T) {
	stubBackupHost(t)
	entries := map[string]string{}
	for i := 0; i < backupMaxEntries+1; i++ {
		entries[fmt.Sprintf("system/x/f%d", i)] = ""
	}
	if _, err := unpackBackupTar(writeTar(t, entries), unpackDest(t)); err == nil || !strings.Contains(err.Error(), "entries") {
		t.Fatalf("too many entries: %v", err)
	}
}

// What apply would refuse shows in the preview (review I4).
func TestCheckReportsInvalidAccounts(t *testing.T) {
	dest := unpackedBackup(t)
	_ = os.WriteFile(filepath.Join(dest, "system", "accounts.json"), []byte(`{"users":[{"name":"root2","uid":0,"gid":0}],"groups":[]}`), 0o600)
	stubAccounts(t, map[string][2]int{}, map[string]int{})
	c := checkBackup(dest)
	if len(c.Conflicts) != 1 || c.Conflicts[0].Kind != "invalid" {
		t.Fatalf("invalid accounts are a conflict: %+v", c.Conflicts)
	}
}

// hsi-share members are only the archived accounts; an unknown member at
// apply is skipped, not fatal (review I4).
func TestMembersLimitedToArchivedUsers(t *testing.T) {
	stubBackupHost(t)
	pm := hostGroupMembers
	t.Cleanup(func() { hostGroupMembers = pm })
	hostGroupMembers = func(string) []string { return []string{"alice", "theo"} }
	acc := backupAccounts([]string{"alice"})
	if len(acc.Groups) != 1 || strings.Join(acc.Groups[0].Members, ",") != "alice" {
		t.Fatalf("members: %+v", acc.Groups)
	}
}

func TestApplySkipsUnknownMembers(t *testing.T) {
	dest := unpackedBackup(t)
	_ = os.WriteFile(filepath.Join(dest, "system", "accounts.json"), []byte(`{"users":[{"name":"alice","uid":1001,"gid":1001}],"groups":[{"name":"hsi-share","gid":1500,"members":["alice","ghost"]}]}`), 0o600)
	stubAccounts(t, map[string][2]int{}, map[string]int{})
	ran := stubRun(t)
	if err := applyBackup(dest, time.Now()); err != nil {
		t.Fatal(err)
	}
	got := argvLines(*ran)
	if !strings.Contains(got, "usermod -aG hsi-share alice") || strings.Contains(got, "ghost") {
		t.Fatalf("members: %s", got)
	}
}

// A replaced app is kept outside the apps folder, so it is not listed as an
// app, and is stopped first (review I5).
func TestKeptAsideAppIsNotAnApp(t *testing.T) {
	dest := unpackedBackup(t)
	stubAccounts(t, map[string][2]int{}, map[string]int{})
	ran := stubRun(t)
	_ = os.WriteFile(filepath.Join(containersDir, "kuma", "compose.yaml"), []byte("services: {mine: {}}\n"), 0o644)
	if err := applyBackup(dest, time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(containersDir)
	for _, e := range entries {
		if e.Name() != "kuma" && !strings.HasPrefix(e.Name(), ".") {
			t.Fatalf("kept-aside copy listed as an app: %s", e.Name())
		}
	}
	if b, _ := os.ReadFile(filepath.Join(containersDir, ".before-restore", "kuma-20261008-100000", "compose.yaml")); string(b) != "services: {mine: {}}\n" {
		t.Fatalf("kept aside: %q", b)
	}
	if !strings.Contains(argvLines(*ran), "docker compose -f "+filepath.Join(containersDir, "kuma", "compose.yaml")+" stop") {
		t.Fatalf("the running app is stopped first: %s", argvLines(*ran))
	}
}

// Only the files at the top of an app folder are configuration (review I6).
func TestAppFilesTopLevelOnly(t *testing.T) {
	dir := stubBackupHost(t)
	_ = os.MkdirAll(filepath.Join(containersDir, "kuma", "data"), 0o755)
	_ = os.WriteFile(filepath.Join(containersDir, "kuma", "data", "db.sqlite"), []byte("x"), 0o644)
	if err := buildBackupTar(dir, nil, "1.65.0", time.Now()); err != nil {
		t.Fatal(err)
	}
	for n := range readTar(t, filepath.Join(dir, "backup.tar")) {
		if strings.Contains(n, "/data/") {
			t.Fatalf("app data captured: %s", n)
		}
	}
}

// The worker writes only its own configured .env, keeping each previous one
// with a timestamp and the file's owner (review I7, M2, M3).
func TestSecretsKeyPinnedPath(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".env")
	t.Setenv("HSI_BACKEND_ENV", p)
	_ = os.WriteFile(p, []byte("HSI_SECRETS_KEY="+strings.Repeat("a", 64)+"\n"), 0o600)
	key := strings.Repeat("b", 64)
	backup, err := setSecretsKey(key, time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(backup, ".before-restore-20261008-100000") {
		t.Fatalf("timestamped: %s", backup)
	}
	if err := restoreSecretsEnv(backup); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); !strings.Contains(string(b), strings.Repeat("a", 64)) {
		t.Fatalf("rolled back: %q", b)
	}
	if _, err := setSecretsKey("not-hex", time.Now()); err == nil {
		t.Fatal("a key must be 64 hex characters")
	}
	if err := restoreSecretsEnv("/etc/passwd"); err == nil {
		t.Fatal("only a kept .env copy can be put back")
	}
}
