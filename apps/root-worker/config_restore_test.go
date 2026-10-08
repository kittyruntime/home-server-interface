package main

import (
	"archive/tar"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// exportedBackup builds an archive with stubBackupHost and returns its path.
func exportedBackup(t *testing.T) string {
	t.Helper()
	dir := stubBackupHost(t)
	if err := buildBackupTar(dir, []string{"alice", "bob"}, "1.65.0", time.Now()); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "backup.tar")
}

func unpackDest(t *testing.T) string {
	t.Helper()
	d := filepath.Join(backupStagingDir(), "restore-1")
	if err := os.MkdirAll(d, 0o700); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestUnpackRoundTrip(t *testing.T) {
	tarPath := exportedBackup(t)
	dest := unpackDest(t)
	m, err := unpackBackupTar(tarPath, dest)
	if err != nil {
		t.Fatal(err)
	}
	if m.Format != 2 || !fileExists(filepath.Join(dest, "system", "containers", "kuma", "compose.yaml")) || !fileExists(filepath.Join(dest, "database.db")) {
		t.Fatalf("unpacked: %+v", m)
	}
}

// writeTar writes a raw archive with the given entries (name -> content; a
// "symlink:" prefix makes a symlink).
func writeTar(t *testing.T, entries map[string]string) string {
	t.Helper()
	p := filepath.Join(backupStagingDir(), "evil.tar")
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	f, _ := os.Create(p)
	tw := tar.NewWriter(f)
	for name, body := range entries {
		if strings.HasPrefix(body, "symlink:") {
			_ = tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeSymlink, Linkname: strings.TrimPrefix(body, "symlink:")})
			continue
		}
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(body)), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(body))
	}
	_ = tw.Close()
	_ = f.Close()
	return p
}

func TestUnpackRejectsTraversal(t *testing.T) {
	stubBackupHost(t)
	for _, entries := range []map[string]string{
		{"../escape": "x"},
		{"/etc/evil": "x"},
		{"system/../../escape": "x"},
		{"system/link": "symlink:/etc/shadow"},
	} {
		dest := unpackDest(t)
		if _, err := unpackBackupTar(writeTar(t, entries), dest); err == nil {
			t.Errorf("%v accepted", entries)
		}
		if fileExists(filepath.Join(backupStagingDir(), "escape")) || fileExists(filepath.Join(filepath.Dir(backupStagingDir()), "escape")) {
			t.Fatal("wrote outside the destination")
		}
	}
	if _, err := unpackBackupTar(exportedBackup(t), t.TempDir()); err == nil {
		t.Fatal("a destination outside the staging directory is refused")
	}
}

func TestUnpackChecksManifest(t *testing.T) {
	tarPath := exportedBackup(t)
	files := readTar(t, tarPath)
	// A changed file (bad sum), a missing one, an extra one.
	for _, mutate := range []func(map[string]string){
		func(m map[string]string) { m["database.db"] = "tampered" },
		func(m map[string]string) { delete(m, "system/accounts.json") },
		func(m map[string]string) { m["system/extra.txt"] = "x" },
	} {
		entries := map[string]string{}
		for k, v := range files {
			entries[k] = string(v)
		}
		mutate(entries)
		if _, err := unpackBackupTar(writeTar(t, entries), unpackDest(t)); err == nil {
			t.Error("manifest mismatch accepted")
		}
	}
}

// stubAccounts makes the server's accounts: users by name (uid, gid) and
// groups by name (gid).
func stubAccounts(t *testing.T, users map[string][2]int, groups map[string]int) {
	t.Helper()
	pu, pg := hostLookupUser, hostLookupGroup
	t.Cleanup(func() { hostLookupUser, hostLookupGroup = pu, pg })
	hostLookupUser = func(n string) (int, int, bool) { v, ok := users[n]; return v[0], v[1], ok }
	hostLookupGroup = func(n string) (int, bool) { v, ok := groups[n]; return v, ok }
	pbu, pbg := hostUserByUID, hostGroupByGID
	t.Cleanup(func() { hostUserByUID, hostGroupByGID = pbu, pbg })
	hostUserByUID = func(uid int) (string, bool) {
		for n, v := range users {
			if v[0] == uid {
				return n, true
			}
		}
		return "", false
	}
	hostGroupByGID = func(gid int) (string, bool) {
		for n, v := range groups {
			if v == gid {
				return n, true
			}
		}
		return "", false
	}
}

func unpackedBackup(t *testing.T) string {
	t.Helper()
	tarPath := exportedBackup(t) // stubs the staging root first
	dest := unpackDest(t)
	if _, err := unpackBackupTar(tarPath, dest); err != nil {
		t.Fatal(err)
	}
	return dest
}

func TestCheckConflicts(t *testing.T) {
	dest := unpackedBackup(t)
	// Fresh server: nothing taken.
	stubAccounts(t, map[string][2]int{}, map[string]int{})
	if c := checkBackup(dest); len(c.Conflicts) != 0 {
		t.Fatalf("fresh: %+v", c.Conflicts)
	}
	// Same server: same names with the same ids.
	stubAccounts(t, map[string][2]int{"alice": {1001, 1001}, "bob": {1002, 1002}}, map[string]int{"alice": 1001, "bob": 1002, "hsi-share": 1500})
	if c := checkBackup(dest); len(c.Conflicts) != 0 {
		t.Fatalf("same server: %+v", c.Conflicts)
	}
	// uid taken by another name, name with another id, group id taken.
	stubAccounts(t, map[string][2]int{"theo": {1001, 1000}, "bob": {1005, 1005}}, map[string]int{"theo": 1000, "share": 1500, "bob": 1005})
	c := checkBackup(dest)
	var kinds []string
	for _, x := range c.Conflicts {
		kinds = append(kinds, x.Kind+":"+x.Name)
		if x.Command == "" {
			t.Errorf("no command for %+v", x)
		}
	}
	got := strings.Join(kinds, " ")
	for _, want := range []string{"uid-taken:alice", "name-other-id:bob", "gid-taken:hsi-share"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in %s", want, got)
		}
	}
}

func TestCheckAppsAndVolumes(t *testing.T) {
	dest := unpackedBackup(t)
	stubAccounts(t, map[string][2]int{}, map[string]int{})
	c := checkBackup(dest) // the stubbed server still has the kuma app with the same files
	if len(c.Apps) != 1 || c.Apps[0].Name != "kuma" || c.Apps[0].State != "same" {
		t.Fatalf("apps: %+v", c.Apps)
	}
	_ = os.WriteFile(filepath.Join(containersDir, "kuma", "compose.yaml"), []byte("services: {x: {}}\n"), 0o644)
	if c := checkBackup(dest); c.Apps[0].State != "different" {
		t.Fatalf("different: %+v", c.Apps)
	}
	_ = os.RemoveAll(filepath.Join(containersDir, "kuma"))
	if c := checkBackup(dest); c.Apps[0].State != "new" {
		t.Fatalf("new: %+v", c.Apps)
	}
	if len(c.Volumes) != 1 || c.Volumes[0].MountPoint != "/srv/data" {
		t.Fatalf("volumes: %+v", c.Volumes)
	}
}

func TestApplyCreatesAccounts(t *testing.T) {
	dest := unpackedBackup(t)
	stubAccounts(t, map[string][2]int{"bob": {1002, 1002}}, map[string]int{"bob": 1002})
	ran := stubRun(t)
	if err := applyBackup(dest, time.Now()); err != nil {
		t.Fatal(err)
	}
	got := argvLines(*ran)
	for _, want := range []string{"groupadd -g 1500 hsi-share", "groupadd -g 1001 alice", "useradd -u 1001 -g 1001 -M -s /usr/sbin/nologin alice"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
	if strings.Contains(got, "useradd -u 1002") {
		t.Error("an account with the same ids is left as it is")
	}
}

func TestApplyRejectsSystemIds(t *testing.T) {
	dest := unpackedBackup(t)
	_ = os.WriteFile(filepath.Join(dest, "system", "accounts.json"), []byte(`{"users":[{"name":"root2","uid":0,"gid":0}],"groups":[]}`), 0o600)
	stubAccounts(t, map[string][2]int{}, map[string]int{})
	ran := stubRun(t)
	if err := applyBackup(dest, time.Now()); err == nil || len(*ran) != 0 {
		t.Fatalf("system ids refused before anything runs: %v %v", err, *ran)
	}
	_ = os.WriteFile(filepath.Join(dest, "system", "accounts.json"), []byte(`{"users":[{"name":"Bad Name","uid":1003,"gid":1003}],"groups":[]}`), 0o600)
	if err := applyBackup(dest, time.Now()); err == nil {
		t.Fatal("invalid names refused")
	}
}

func TestApplyRechecksConflicts(t *testing.T) {
	dest := unpackedBackup(t)
	stubAccounts(t, map[string][2]int{"intruder": {1001, 1001}}, map[string]int{})
	ran := stubRun(t)
	if err := applyBackup(dest, time.Now()); err == nil || !strings.Contains(err.Error(), "conflict") || len(*ran) != 0 {
		t.Fatalf("conflict found at apply: %v %v", err, *ran)
	}
}

func TestApplyKeepsAppsAside(t *testing.T) {
	dest := unpackedBackup(t)
	stubAccounts(t, map[string][2]int{}, map[string]int{})
	stubRun(t)
	_ = os.WriteFile(filepath.Join(containersDir, "kuma", "compose.yaml"), []byte("services: {mine: {}}\n"), 0o644)
	if err := applyBackup(dest, time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	aside, _ := os.ReadFile(filepath.Join(containersDir, "kuma.before-restore-20261008-100000", "compose.yaml"))
	now, _ := os.ReadFile(filepath.Join(containersDir, "kuma", "compose.yaml"))
	if string(aside) != "services: {mine: {}}\n" || string(now) != "services: {}\n" {
		t.Fatalf("aside %q now %q", aside, now)
	}
}

func TestApplyKeepsDescriptionsAside(t *testing.T) {
	dest := unpackedBackup(t)
	stubAccounts(t, map[string][2]int{}, map[string]int{})
	stubRun(t)
	p := filepath.Join(storageDescriptionsDir(), "srv-data.yaml")
	_ = os.WriteFile(p, []byte("version: 1\nmount:\n  point: /srv/data\n  options: mine\n"), 0o644)
	if err := applyBackup(dest, time.Now()); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p + ".before-restore"); !strings.Contains(string(b), "mine") {
		t.Fatalf("kept aside: %q", b)
	}
}

func TestReplaceSecretsKey(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".env")
	_ = os.WriteFile(p, []byte("A=1\nHSI_SECRETS_KEY=old\nB=2\n"), 0o600)
	if err := replaceSecretsKey(p, "new"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	old, _ := os.ReadFile(p + ".before-restore")
	if string(b) != "A=1\nHSI_SECRETS_KEY=new\nB=2\n" || !strings.Contains(string(old), "=old") {
		t.Fatalf("%q / %q", b, old)
	}
	_ = os.WriteFile(p, []byte("A=1\n"), 0o600)
	_ = replaceSecretsKey(p, "k")
	if b, _ := os.ReadFile(p); string(b) != "A=1\nHSI_SECRETS_KEY=k\n" {
		t.Fatalf("added: %q", b)
	}
	if err := replaceSecretsKey(p, "bad\nX=1"); err == nil {
		t.Fatal("a key with a line break is refused")
	}
}

func stubRun(t *testing.T) *[][]string {
	t.Helper()
	pr := runArgv
	t.Cleanup(func() { runArgv = pr })
	ran := &[][]string{}
	runArgv = func(argv []string) ([]byte, error) { *ran = append(*ran, argv); return nil, nil }
	return ran
}

func argvLines(ran [][]string) string {
	var out []string
	for _, a := range ran {
		out = append(out, strings.Join(a, " "))
	}
	return strings.Join(out, "\n")
}
