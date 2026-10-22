package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// updateEnv is a fake host: every path the update code touches, under one temp dir.
type updateEnv struct {
	state, install, systemd, workerEnv, backendEnv, natsConf, tls, backupConf, db string
}

func setupUpdateEnv(t *testing.T) *updateEnv {
	t.Helper()
	root := t.TempDir()
	e := &updateEnv{
		state:      filepath.Join(root, "state"),
		install:    filepath.Join(root, "opt"),
		systemd:    filepath.Join(root, "systemd"),
		workerEnv:  filepath.Join(root, "etc", "worker.env"),
		backendEnv: filepath.Join(root, "opt", ".env"),
		natsConf:   filepath.Join(root, "etc", "nats.conf"),
		tls:        filepath.Join(root, "tls"),
		backupConf: filepath.Join(root, "etc", "backup.json"),
		db:         filepath.Join(root, "opt", "database", "data", "hsi.db"),
	}
	for k, v := range map[string]string{
		"HSI_UPDATE_STATE": e.state, "HSI_INSTALL_DIR": e.install, "HSI_SYSTEMD_DIR": e.systemd,
		"HSI_WORKER_ENV": e.workerEnv, "HSI_BACKEND_ENV": e.backendEnv, "HSI_NATS_CONF": e.natsConf,
		"HSI_TLS_DIR": e.tls, "HSI_BACKUP_CONFIG": e.backupConf, "HSI_UPDATE_DB": e.db, "HSI_UNIT_PREFIX": "hsi",
	} {
		t.Setenv(k, v)
	}
	for _, d := range []string{e.state, e.systemd, filepath.Dir(e.workerEnv), e.tls, filepath.Dir(e.db), filepath.Join(e.install, "releases")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return e
}

func (e *updateEnv) release(t *testing.T, versions ...string) {
	t.Helper()
	for _, v := range versions {
		if err := os.MkdirAll(filepath.Join(e.install, "releases", v), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

// fakeSystemctl records each call as one space-joined line.
func fakeSystemctl(t *testing.T) *[]string {
	t.Helper()
	var calls []string
	var mu sync.Mutex
	prev := systemctl
	systemctl = func(args ...string) ([]byte, error) {
		mu.Lock()
		defer mu.Unlock()
		calls = append(calls, strings.Join(args, " "))
		return nil, nil
	}
	t.Cleanup(func() { systemctl = prev })
	return &calls
}

// fakeHealth swaps both probes; nil funcs mean healthy.
func fakeHealth(t *testing.T, httpErr, natsErr func() error) {
	t.Helper()
	prevHTTP, prevNATS, prevTimeout, prevInterval := httpHealth, natsHealth, healthTimeout, healthInterval
	httpHealth = func(healthTarget) error {
		if httpErr != nil {
			return httpErr()
		}
		return nil
	}
	natsHealth = func() error {
		if natsErr != nil {
			return natsErr()
		}
		return nil
	}
	healthTimeout, healthInterval = 50*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() {
		httpHealth, natsHealth, healthTimeout, healthInterval = prevHTTP, prevNATS, prevTimeout, prevInterval
	})
}

func TestSnapshotCopiesDbAndConfig(t *testing.T) {
	e := setupUpdateEnv(t)
	mustWrite(t, e.db, []byte("database v2.0.0"))
	mustWrite(t, e.workerEnv, []byte("NATS_PASS=old\n"))
	if err := os.WriteFile(filepath.Join(e.systemd, "hsi-server.service"), []byte("[Service]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/dev/null", filepath.Join(e.systemd, "hsi-masked.timer")); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(e.systemd, "other.service"), []byte("not ours"))

	dir, err := takeSnapshot("v2.0.0", "v2.1.0", e.db, snapshotConfigFiles())
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Join(e.state, "v2.0.0-v2.1.0") {
		t.Fatalf("snapshot dir %s", dir)
	}
	m, err := readManifest(dir)
	if err != nil {
		t.Fatal(err)
	}
	if m.From != "v2.0.0" || m.To != "v2.1.0" || m.DBTarget != e.db || m.Created.IsZero() {
		t.Fatalf("manifest %+v", m)
	}
	if got := string(mustRead(t, snapshotPath(dir, m.Database))); got != "database v2.0.0" {
		t.Fatalf("db copy %q", got)
	}
	byName := map[string]snapFile{}
	for _, f := range m.Files {
		byName[f.Src] = f
	}
	if f := byName[e.workerEnv]; !f.Existed || f.Mode != 0o600 || string(mustRead(t, snapshotPath(dir, f.Saved))) != "NATS_PASS=old\n" {
		t.Fatalf("worker.env entry %+v", f)
	}
	for _, missing := range []string{e.natsConf, e.backendEnv, filepath.Join(e.tls, "tls.json"), e.backupConf} {
		if f, ok := byName[missing]; !ok || f.Existed {
			t.Fatalf("%s must be listed with existed=false, got %+v (listed %v)", missing, f, ok)
		}
	}
	unit := byName[filepath.Join(e.systemd, "hsi-server.service")]
	if !unit.Existed {
		t.Fatal("unit file not snapshotted")
	}
	link := byName[filepath.Join(e.systemd, "hsi-masked.timer")]
	if target, err := os.Readlink(snapshotPath(dir, link.Saved)); err != nil || target != "/dev/null" {
		t.Fatalf("a unit symlink must be saved as a symlink, got %q %v", target, err)
	}
	if _, ok := byName[filepath.Join(e.systemd, "other.service")]; ok {
		t.Fatal("a unit without the prefix was snapshotted")
	}

	// The field names are a contract with the installer (it writes the first snapshot itself).
	raw := mustRead(t, filepath.Join(dir, "manifest.json"))
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keys); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"from", "to", "created", "database", "dbTarget", "files"} {
		if _, ok := keys[k]; !ok {
			t.Fatalf("manifest lacks %q: %s", k, raw)
		}
	}
	var files []map[string]json.RawMessage
	_ = json.Unmarshal(keys["files"], &files)
	for _, k := range []string{"src", "saved", "mode", "existed"} {
		if _, ok := files[0][k]; !ok {
			t.Fatalf("file entry lacks %q: %s", k, keys["files"])
		}
	}
}

func TestSnapshotRefusesBadVersions(t *testing.T) {
	e := setupUpdateEnv(t)
	mustWrite(t, e.db, []byte("db"))
	for _, v := range []string{"../x", "v1.2.3/..", "", "1.2.3"} {
		if _, err := takeSnapshot(v, "v2.0.0", e.db, nil); err == nil {
			t.Errorf("accepted from %q", v)
		}
	}
	if _, err := takeSnapshot("v0.0.0-flat", "v2.0.0", e.db, nil); err != nil {
		t.Fatalf("the flat install marker version is valid: %v", err)
	}
}

func TestReadManifestResolvesRelativePaths(t *testing.T) {
	e := setupUpdateEnv(t)
	dir := filepath.Join(e.state, "v1.66.0-v1.67.0")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(dir, "manifest.json"), []byte(`{"from":"v1.66.0","to":"v1.67.0","created":"2026-10-22T10:00:00Z",
"database":"database/hsi.db","dbTarget":"`+e.db+`",
"files":[{"src":"`+e.workerEnv+`","saved":"files/0-worker.env","mode":384,"existed":true}]}`))
	m, err := readManifest(dir)
	if err != nil {
		t.Fatal(err)
	}
	if snapshotPath(dir, m.Database) != filepath.Join(dir, "database", "hsi.db") || m.Files[0].Mode != 0o600 {
		t.Fatalf("manifest %+v", m)
	}
}

func TestSwitchCurrentIsAtomic(t *testing.T) {
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0", "v2.1.0")
	if err := switchCurrent("v2.0.0"); err != nil {
		t.Fatal(err)
	}
	if currentVersion() != "v2.0.0" {
		t.Fatalf("current %q", currentVersion())
	}
	link := filepath.Join(e.install, "current")
	var missing atomic.Bool
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
			}
			if _, err := os.Lstat(link); errors.Is(err, os.ErrNotExist) {
				missing.Store(true)
			}
		}
	}()
	for i := 0; i < 200; i++ {
		v := []string{"v2.1.0", "v2.0.0"}[i%2]
		if err := switchCurrent(v); err != nil {
			t.Fatal(err)
		}
	}
	close(stop)
	<-done
	if missing.Load() {
		t.Fatal("the current link was missing during a switch")
	}
	if currentVersion() != "v2.0.0" {
		t.Fatalf("current %q", currentVersion())
	}
	entries, _ := os.ReadDir(e.install)
	for _, en := range entries {
		if strings.Contains(en.Name(), "tmp") {
			t.Fatalf("leftover %s", en.Name())
		}
	}
	if err := switchCurrent("v9.9.9"); err == nil {
		t.Fatal("switched to a version that is not installed")
	}
	if err := switchCurrent("../../etc"); err == nil {
		t.Fatal("switched to an invalid version")
	}
}

func writeTestManifest(t *testing.T, e *updateEnv, from, to string, created time.Time) string {
	t.Helper()
	dir := filepath.Join(e.state, from+"-"+to)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(snapshotManifest{From: from, To: to, Created: created, Database: "database/hsi.db", DBTarget: e.db})
	mustWrite(t, filepath.Join(dir, "manifest.json"), b)
	return dir
}

func TestCommitPrunesToTwo(t *testing.T) {
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0", "v2.1.0", "v2.2.0", "v2.3.0", "v2.4.0")
	if err := switchCurrent("v2.4.0"); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	writeTestManifest(t, e, "v2.0.0", "v2.1.0", base)
	writeTestManifest(t, e, "v2.1.0", "v2.2.0", base.Add(time.Hour))
	writeTestManifest(t, e, "v2.2.0", "v2.3.0", base.Add(2*time.Hour))
	last := writeTestManifest(t, e, "v2.3.0", "v2.4.0", base.Add(3*time.Hour))
	if err := writeInProgress(inProgress{From: "v2.3.0", To: "v2.4.0", Snapshot: last, Step: "health", PID: 1}); err != nil {
		t.Fatal(err)
	}

	if code := runUpdateCLI([]string{"commit", "v2.3.0", "v2.4.0", last}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	var releases []string
	entries, _ := os.ReadDir(filepath.Join(e.install, "releases"))
	for _, en := range entries {
		releases = append(releases, en.Name())
	}
	if strings.Join(releases, ",") != "v2.2.0,v2.3.0,v2.4.0" {
		t.Fatalf("releases kept: %v", releases)
	}
	for _, gone := range []string{"v2.0.0-v2.1.0", "v2.1.0-v2.2.0"} {
		if _, err := os.Stat(filepath.Join(e.state, gone)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("snapshot %s kept", gone)
		}
	}
	for _, kept := range []string{"v2.2.0-v2.3.0", "v2.3.0-v2.4.0"} {
		if _, err := os.Stat(filepath.Join(e.state, kept, "manifest.json")); err != nil {
			t.Fatalf("snapshot %s removed", kept)
		}
	}
	r, err := readLast()
	if err != nil || r == nil || r.Status != "success" || r.From != "v2.3.0" || r.To != "v2.4.0" {
		t.Fatalf("last %+v %v", r, err)
	}
	if p, _ := readInProgress(); p != nil {
		t.Fatal("the in-progress marker was kept")
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"v1.2.3", "v1.2.3", 0}, {"v1.10.0", "v1.9.9", 1}, {"v0.0.0-flat", "v0.0.1", -1}, {"v2.0.0", "v10.0.0", -1},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compare(%s,%s)=%d", c.a, c.b, got)
		}
	}
}
