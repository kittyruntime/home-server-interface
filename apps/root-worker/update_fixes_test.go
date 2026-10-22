package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// ── S1: snapshot sources are never followed ──────────────────────────────────

func TestSnapshotRefusesSymlinkedDatabase(t *testing.T) {
	e := setupUpdateEnv(t)
	secret := filepath.Join(t.TempDir(), "shadow")
	mustWrite(t, secret, []byte("root secret"))
	if err := os.Symlink(secret, e.db); err != nil {
		t.Fatal(err)
	}
	if _, err := takeSnapshot("v2.0.0", "v2.1.0", e.db, nil); err == nil {
		t.Fatal("a symlinked database was copied")
	}
	assertNoCopyOf(t, e.state, "root secret")
}

func TestSnapshotRefusesSymlinkedParent(t *testing.T) {
	e := setupUpdateEnv(t)
	real := t.TempDir()
	mustWrite(t, filepath.Join(real, "hsi.db"), []byte("root secret"))
	dataDir := filepath.Dir(e.db)
	if err := os.RemoveAll(dataDir); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, dataDir); err != nil {
		t.Fatal(err)
	}
	if _, err := takeSnapshot("v2.0.0", "v2.1.0", e.db, nil); err == nil {
		t.Fatal("a database behind a symlinked directory was copied")
	}
	assertNoCopyOf(t, e.state, "root secret")
}

func TestSnapshotRefusesSymlinkedConfigFile(t *testing.T) {
	e := setupUpdateEnv(t)
	mustWrite(t, e.db, []byte("db"))
	secret := filepath.Join(t.TempDir(), "shadow")
	mustWrite(t, secret, []byte("root secret"))
	if err := os.Symlink(secret, e.backendEnv); err != nil {
		t.Fatal(err)
	}
	if _, err := takeSnapshot("v2.0.0", "v2.1.0", e.db, snapshotConfigFiles()); err == nil {
		t.Fatal("a symlinked .env was followed")
	}
	assertNoCopyOf(t, e.state, "root secret")
}

func TestSnapshotRefusesFifoAndHardLink(t *testing.T) {
	e := setupUpdateEnv(t)
	if err := syscall.Mkfifo(e.db, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := takeSnapshot("v2.0.0", "v2.1.0", e.db, nil); err == nil {
		t.Fatal("a FIFO was accepted as the database")
	}
	_ = os.Remove(e.db)
	other := filepath.Join(filepath.Dir(e.db), "other")
	mustWrite(t, other, []byte("linked"))
	if err := os.Link(other, e.db); err != nil {
		t.Fatal(err)
	}
	if _, err := takeSnapshot("v2.0.0", "v2.1.0", e.db, nil); err == nil {
		t.Fatal("a database with another hard link was accepted")
	}
}

func assertNoCopyOf(t *testing.T, dir, content string) {
	t.Helper()
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err == nil && info.Mode().IsRegular() {
			if b, _ := os.ReadFile(p); strings.Contains(string(b), content) {
				t.Errorf("%s holds a copy of a file outside the update", p)
			}
		}
		return nil
	})
}

// ── S2: restore never follows a planted symlink ──────────────────────────────

func TestRollbackReplacesPlantedSymlinkWithoutFollowing(t *testing.T) {
	e, dir := preparedUpdate(t)
	fakeSystemctl(t)
	fakeHealth(t, nil, nil)
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("untouched"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(e.workerEnv)
	if err := os.Symlink(outside, e.workerEnv); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(e.db + "-wal")
	if err := os.Symlink(outside, e.db+"-wal"); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(e.natsConf)
	if err := os.Symlink(outside, e.natsConf); err != nil {
		t.Fatal(err)
	}

	if err := rollback(dir, "health", "x"); err != nil {
		t.Fatal(err)
	}
	st, err := os.Lstat(e.workerEnv)
	if err != nil || !st.Mode().IsRegular() || string(mustRead(t, e.workerEnv)) != "OLD=1\n" {
		t.Fatalf("worker.env not restored as a regular file: %v %v", st, err)
	}
	ost, _ := os.Stat(outside)
	if string(mustRead(t, outside)) != "untouched" || ost.Mode().Perm() != 0o644 {
		t.Fatalf("a file outside was changed through a planted link: mode %v", ost.Mode().Perm())
	}
	for _, p := range []string{e.db + "-wal", e.natsConf} {
		if _, err := os.Lstat(p); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s kept", p)
		}
	}
}

func TestRollbackRefusesSymlinkedDestinationParent(t *testing.T) {
	e, dir := preparedUpdate(t)
	fakeSystemctl(t)
	fakeHealth(t, nil, nil)
	elsewhere := t.TempDir()
	mustWrite(t, filepath.Join(elsewhere, "hsi.db"), []byte("elsewhere"))
	dataDir := filepath.Dir(e.db)
	moved := dataDir + ".real"
	if err := os.Rename(dataDir, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, dataDir); err != nil {
		t.Fatal(err)
	}
	if err := rollback(dir, "health", "x"); err == nil {
		t.Fatal("restored through a symlinked directory")
	}
	if string(mustRead(t, filepath.Join(elsewhere, "hsi.db"))) != "elsewhere" {
		t.Fatal("wrote through a symlinked directory")
	}
	if r, _ := readLast(); r == nil || r.Status != "rollback-failed" {
		t.Fatalf("last %+v", r)
	}
}

// ── I1: everything the manifest names is confined ────────────────────────────

func TestRollbackConfinesManifestPaths(t *testing.T) {
	cases := map[string]func(e *updateEnv, dir string, m *snapshotManifest) string{
		"snapshot outside the state dir": func(e *updateEnv, dir string, m *snapshotManifest) string {
			other := filepath.Join(t.TempDir(), "v2.0.0-v2.1.0")
			if err := os.Rename(dir, other); err != nil {
				t.Fatal(err)
			}
			return other
		},
		"snapshot name not from-to": func(e *updateEnv, dir string, m *snapshotManifest) string {
			other := filepath.Join(e.state, "v2.0.0-v9.9.9")
			if err := os.Rename(dir, other); err != nil {
				t.Fatal(err)
			}
			return other
		},
		"src outside the config files": func(e *updateEnv, dir string, m *snapshotManifest) string {
			m.Files = append(m.Files, snapFile{Src: "/etc/passwd", Existed: false})
			return dir
		},
		"unit of another prefix": func(e *updateEnv, dir string, m *snapshotManifest) string {
			m.Files = append(m.Files, snapFile{Src: filepath.Join(e.systemd, "ssh.service"), Existed: false})
			return dir
		},
		"db target elsewhere": func(e *updateEnv, dir string, m *snapshotManifest) string {
			m.DBTarget = "/etc/shadow"
			return dir
		},
		"saved outside the snapshot": func(e *updateEnv, dir string, m *snapshotManifest) string {
			m.Files[0].Saved = "../../x"
			return dir
		},
		"database outside the snapshot": func(e *updateEnv, dir string, m *snapshotManifest) string {
			m.Database = "/etc/shadow"
			return dir
		},
		"mode out of range": func(e *updateEnv, dir string, m *snapshotManifest) string {
			m.Files[0].Mode = 0o4755
			return dir
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			e, dir := preparedUpdate(t)
			calls := fakeSystemctl(t)
			fakeHealth(t, nil, nil)
			var m snapshotManifest
			if err := json.Unmarshal(mustRead(t, filepath.Join(dir, "manifest.json")), &m); err != nil {
				t.Fatal(err)
			}
			dir = mutate(e, dir, &m)
			b, _ := json.Marshal(m)
			mustWrite(t, filepath.Join(dir, "manifest.json"), b)
			if err := rollback(dir, "health", "x"); err == nil {
				t.Fatal("accepted")
			}
			if len(*calls) != 0 || string(mustRead(t, e.db)) != "new db" {
				t.Fatalf("acted on a bad manifest: %v", *calls)
			}
			if r, _ := readLast(); r == nil || r.Status != "rollback-failed" {
				t.Fatalf("last %+v", r)
			}
		})
	}
}

// ── I2: no restore and no start after a failed stop or switch ───────────────

func TestRollbackStopsShortWhenStopOrSwitchFails(t *testing.T) {
	t.Run("stop fails", func(t *testing.T) {
		e, dir := preparedUpdate(t)
		calls := fakeSystemctl(t)
		inner := systemctl
		systemctl = func(args ...string) ([]byte, error) {
			out, _ := inner(args...)
			if args[0] == "stop" {
				return []byte("Job failed"), errors.New("exit status 1")
			}
			return out, nil
		}
		fakeHealth(t, nil, nil)
		if err := rollback(dir, "health", "x"); err == nil {
			t.Fatal("succeeded")
		}
		assertStoppedShort(t, e, dir, calls)
		if currentVersion() != "v2.1.0" {
			t.Fatal("switched after a failed stop")
		}
	})
	t.Run("release missing", func(t *testing.T) {
		e, dir := preparedUpdate(t)
		calls := fakeSystemctl(t)
		fakeHealth(t, nil, nil)
		if err := os.RemoveAll(filepath.Join(e.install, "releases", "v2.0.0")); err != nil {
			t.Fatal(err)
		}
		if err := rollback(dir, "health", "x"); err == nil {
			t.Fatal("succeeded")
		}
		assertStoppedShort(t, e, dir, calls)
	})
}

func assertStoppedShort(t *testing.T, e *updateEnv, dir string, calls *[]string) {
	t.Helper()
	for _, c := range *calls {
		if strings.HasPrefix(c, "start") {
			t.Fatalf("started after a failed step: %v", *calls)
		}
	}
	if string(mustRead(t, e.db)) != "new db" {
		t.Fatal("restored after a failed step")
	}
	r, _ := readLast()
	if r == nil || r.Status != "rollback-failed" || !strings.Contains(r.Reason, "update rollback --snapshot "+dir) {
		t.Fatalf("last %+v", r)
	}
}

// ── I3: an imported certificate is pinned, its expiry does not fail the probe ─

func expiredCert(t *testing.T) (tls.Certificate, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "nas.example"},
		NotBefore: time.Now().Add(-2 * 365 * 24 * time.Hour), NotAfter: time.Now().Add(-365 * 24 * time.Hour),
		DNSNames: []string{"nas.example"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func TestHttpHealthPinsAnExpiredImportedCertificate(t *testing.T) {
	e := setupUpdateEnv(t)
	cert, certPEM := expiredCert(t)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","nats":true,"db":true,"version":"v2.1.0"}`))
	}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
	srv.StartTLS()
	defer srv.Close()
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	mustWrite(t, filepath.Join(e.tls, "tls.json"), []byte(fmt.Sprintf(`{"mode":"imported","port":%d}`, port)))
	mustWrite(t, filepath.Join(e.tls, "server.crt"), certPEM)

	tg := healthTargetFor("v2.1.0")
	tg.Timeout = time.Second
	if err := httpHealth(tg); err != nil {
		t.Fatalf("the pinned expired certificate was refused: %v", err)
	}
	_, otherPEM := expiredCert(t)
	mustWrite(t, filepath.Join(e.tls, "server.crt"), otherPEM)
	tg = healthTargetFor("v2.1.0")
	tg.Timeout = time.Second
	if err := httpHealth(tg); err == nil {
		t.Fatal("a certificate other than server.crt was accepted")
	}
}

// ── M3: a marker from before the boot does not trust its PID ─────────────────

func TestRecoverIgnoresPIDFromBeforeBoot(t *testing.T) {
	_, dir := preparedUpdate(t)
	fakeSystemctl(t)
	fakeHealth(t, nil, nil)
	started := inProcessRecovery(t)
	prev := bootTime
	bootTime = func() time.Time { return time.Now().Add(time.Hour) }
	t.Cleanup(func() { bootTime = prev })
	_ = writeInProgress(inProgress{From: "v2.0.0", To: "v2.1.0", Snapshot: dir, Step: "health", PID: os.Getpid(), Started: time.Now()})
	recoverInterrupted()
	if *started != 1 {
		t.Fatal("a PID reused after a reboot blocked the recovery")
	}
	if r, _ := readLast(); r == nil || r.Status != "rolled-back" {
		t.Fatalf("last %+v", r)
	}
}

// ── M4: rollback --yes takes the lock unless the installer holds it ──────────

func TestScriptedRollbackTakesTheLock(t *testing.T) {
	e, dir := preparedUpdate(t)
	calls := fakeSystemctl(t)
	fakeHealth(t, nil, nil)
	lock, err := os.OpenFile(filepath.Join(e.state, "update.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HSI_UPDATE_LOCK_HELD", "")
	if code := runUpdateCLI([]string{"rollback", "--snapshot", dir, "--yes"}); code != 1 || len(*calls) != 0 {
		t.Fatalf("rolled back under another process's lock: exit %d, %v", code, *calls)
	}
	t.Setenv("HSI_UPDATE_LOCK_HELD", "1")
	if code := runUpdateCLI([]string{"rollback", "--snapshot", dir, "--yes"}); code != 0 {
		t.Fatalf("the installer's own rollback was refused: exit %d", code)
	}
}

// ── M5: the target is snapshotted; wants links of removed units go ───────────

func TestRollbackCleansWantsOfRemovedUnits(t *testing.T) {
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0", "v2.1.0")
	_ = switchCurrent("v2.0.0")
	mustWrite(t, e.db, []byte("old db"))
	mustWrite(t, filepath.Join(e.systemd, "hsi.target"), []byte("old target\n"))
	dir, err := takeSnapshot("v2.0.0", "v2.1.0", e.db, snapshotConfigFiles())
	if err != nil {
		t.Fatal(err)
	}
	_ = switchCurrent("v2.1.0")
	mustWrite(t, filepath.Join(e.systemd, "hsi.target"), []byte("new target\n"))
	mustWrite(t, filepath.Join(e.systemd, "hsi-new.timer"), []byte("new\n"))
	wants := filepath.Join(e.systemd, "timers.target.wants")
	if err := os.MkdirAll(wants, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(e.systemd, "hsi-new.timer"), filepath.Join(wants, "hsi-new.timer")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/lib/systemd/system/other.timer", filepath.Join(wants, "other.timer")); err != nil {
		t.Fatal(err)
	}
	fakeSystemctl(t)
	fakeHealth(t, nil, nil)
	if err := rollback(dir, "health", "x"); err != nil {
		t.Fatal(err)
	}
	if string(mustRead(t, filepath.Join(e.systemd, "hsi.target"))) != "old target\n" {
		t.Fatal("hsi.target not restored")
	}
	if _, err := os.Lstat(filepath.Join(wants, "hsi-new.timer")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the wants link of a removed unit was kept")
	}
	if _, err := os.Lstat(filepath.Join(wants, "other.timer")); err != nil {
		t.Fatal("an unrelated wants link was removed")
	}
}

// ── M6: only dirs, files and links; no setuid or setgid ──────────────────────

// ── M7: broken snapshots and old staging dirs are pruned ─────────────────────

func TestPruneRemovesBrokenSnapshotsAndOldStaging(t *testing.T) {
	e := setupUpdateEnv(t)
	good := writeTestManifest(t, e, "v2.0.0", "v2.1.0", time.Now())
	broken := filepath.Join(e.state, "v2.1.0-v2.2.0")
	if err := os.MkdirAll(broken, 0o700); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(broken, "manifest.json"), []byte("{"))
	missing := filepath.Join(e.state, "v2.2.0-v2.3.0")
	_ = os.MkdirAll(missing, 0o700)
	oldStage := filepath.Join(e.state, "apply-old")
	newStage := filepath.Join(e.state, "apply-new")
	_ = os.MkdirAll(oldStage, 0o700)
	_ = os.MkdirAll(newStage, 0o700)
	past := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(oldStage, past, past); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(e.state, "notes")
	_ = os.MkdirAll(other, 0o700)

	pruneSnapshots(2)
	pruneStaging(24 * time.Hour)
	for _, gone := range []string{broken, missing, oldStage} {
		if _, err := os.Stat(gone); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s kept", gone)
		}
	}
	for _, kept := range []string{good, newStage, other} {
		if _, err := os.Stat(kept); err != nil {
			t.Errorf("%s removed", kept)
		}
	}
}

// ── M9: commit checks its arguments against the marker ───────────────────────

func TestCommitValidatesAgainstMarker(t *testing.T) {
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0", "v2.1.0")
	_ = switchCurrent("v2.1.0")
	snap := writeTestManifest(t, e, "v2.0.0", "v2.1.0", time.Now())
	for _, args := range [][]string{
		{"commit", "../x", "v2.1.0", snap},
		{"commit", "v2.0.0", "v2.1.0", snap}, // no marker
	} {
		if code := runUpdateCLI(args); code == 0 {
			t.Errorf("%v accepted", args)
		}
	}
	_ = writeInProgress(inProgress{From: "v2.0.0", To: "v2.1.0", Snapshot: snap, Step: "health", PID: 1})
	for _, args := range [][]string{
		{"commit", "v1.9.0", "v2.1.0", snap},
		{"commit", "v2.0.0", "v2.1.0", filepath.Join(e.state, "other")},
	} {
		if code := runUpdateCLI(args); code == 0 {
			t.Errorf("%v accepted", args)
		}
	}
	if r, _ := readLast(); r != nil {
		t.Fatalf("a refused commit wrote %+v", r)
	}
	if code := runUpdateCLI([]string{"commit", "v2.0.0", "v2.1.0", snap}); code != 0 {
		t.Fatalf("exit %d", code)
	}
}

// ── Every update path honours its HSI_* override; the defaults stay ──────────

func TestUpdatePathsHonourOverrides(t *testing.T) {
	paths := map[string]func() string{
		"HSI_UPDATE_STATE": updateStateDir, "HSI_INSTALL_DIR": installRoot, "HSI_UPDATE_DB": updateDBPath,
		"HSI_WORKER_ENV": workerEnvPath, "HSI_NATS_CONF": natsConfPath, "HSI_BACKEND_ENV": backendEnvPath,
		"HSI_TLS_DIR": tlsDir, "HSI_BACKUP_CONFIG": backupConfigPath, "HSI_SYSTEMD_DIR": systemdDir, "HSI_UNIT_PREFIX": unitPrefix,
	}
	defaults := map[string]string{
		"HSI_UPDATE_STATE": "/var/lib/hsi/update", "HSI_INSTALL_DIR": "/opt/hsi", "HSI_UPDATE_DB": "/opt/hsi/database/data/hsi.db",
		"HSI_WORKER_ENV": "/etc/hsi/worker.env", "HSI_NATS_CONF": "/etc/hsi/nats.conf", "HSI_BACKEND_ENV": "/opt/hsi/.env",
		"HSI_TLS_DIR": "/var/lib/hsi/tls", "HSI_BACKUP_CONFIG": "/etc/hsi/backup.json", "HSI_SYSTEMD_DIR": "/etc/systemd/system", "HSI_UNIT_PREFIX": "hsi",
	}
	for k, f := range paths {
		t.Setenv(k, "")
		if got := f(); got != defaults[k] {
			t.Errorf("%s default %q, want %q", k, got, defaults[k])
		}
		t.Setenv(k, "/custom/"+k)
		if got := f(); got != "/custom/"+k {
			t.Errorf("%s override ignored: %q", k, got)
		}
		t.Setenv(k, "")
	}
	t.Setenv("HSI_INSTALL_DIR", "/srv/app")
	if updateDBPath() != "/srv/app/database/data/hsi.db" || currentLink() != "/srv/app/current" || releasesDir() != "/srv/app/releases" {
		t.Fatal("paths under the install dir do not follow HSI_INSTALL_DIR")
	}
	t.Setenv("HSI_UPDATE_STATE", "/srv/state")
	if updateLockPath() != "/srv/state/update.lock" {
		t.Fatal("the lock does not follow HSI_UPDATE_STATE")
	}
}

// ── Fix round 2 ───────────────────────────────────────────────────────────────

// breakSnapshotDB makes the snapshot's database copy unusable (a directory).
func breakSnapshotDB(t *testing.T, dir string) {
	t.Helper()
	db := filepath.Join(dir, "database", "hsi.db")
	if err := os.Remove(db); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(db, 0o700); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreDatabaseFailedCopyKeepsLiveFiles(t *testing.T) {
	e, dir := preparedUpdate(t)
	breakSnapshotDB(t, dir)
	m, err := readManifest(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := restoreDatabase(dir, m); err == nil {
		t.Fatal("restored from a broken copy")
	}
	if string(mustRead(t, e.db)) != "new db" || string(mustRead(t, e.db+"-wal")) != "new wal" {
		t.Fatal("a failed copy changed the live database or its journal")
	}
	entries, _ := os.ReadDir(filepath.Dir(e.db))
	for _, en := range entries {
		if strings.Contains(en.Name(), "hsi-tmp") {
			t.Fatalf("leftover %s", en.Name())
		}
	}
}

func TestRollbackDoesNotStartAfterFailedRestore(t *testing.T) {
	_, dir := preparedUpdate(t)
	breakSnapshotDB(t, dir)
	calls := fakeSystemctl(t)
	fakeHealth(t, nil, nil)
	if err := rollback(dir, "health", "x"); err == nil {
		t.Fatal("succeeded")
	}
	for _, c := range *calls {
		if strings.HasPrefix(c, "start") || c == "daemon-reload" {
			t.Fatalf("went on after a failed restore: %v", *calls)
		}
	}
	r, _ := readLast()
	if r == nil || r.Status != "rollback-failed" || !strings.Contains(r.Reason, "update rollback --snapshot "+dir) {
		t.Fatalf("last %+v", r)
	}
}

func TestSnapshotNamesSymlinkedDatabasePath(t *testing.T) {
	e := setupUpdateEnv(t)
	real := t.TempDir()
	mustWrite(t, filepath.Join(real, "hsi.db"), []byte("db"))
	dataDir := filepath.Dir(e.db)
	_ = os.RemoveAll(dataDir)
	if err := os.Symlink(real, dataDir); err != nil {
		t.Fatal(err)
	}
	want := "The database path " + e.db + " goes through a symbolic link; updates need the real path (set HSI_UPDATE_DB)"
	if _, err := takeSnapshot("v2.0.0", "v2.1.0", e.db, nil); err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("want %q, got %v", want, err)
	}
	_ = os.Remove(dataDir)
	_ = os.MkdirAll(dataDir, 0o755)
	if err := os.Symlink(filepath.Join(real, "hsi.db"), e.db); err != nil {
		t.Fatal(err)
	}
	if _, err := takeSnapshot("v2.0.0", "v2.1.0", e.db, nil); err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("want %q for a linked file, got %v", want, err)
	}
}

func TestSnapshotNamesSymlinkedStateDir(t *testing.T) {
	e := setupUpdateEnv(t)
	mustWrite(t, e.db, []byte("db"))
	_ = os.RemoveAll(e.state)
	if err := os.Symlink(t.TempDir(), e.state); err != nil {
		t.Fatal(err)
	}
	_, err := takeSnapshot("v2.0.0", "v2.1.0", e.db, nil)
	if err == nil || !strings.Contains(err.Error(), "update state folder") || strings.Contains(err.Error(), "repository") {
		t.Fatalf("got %v", err)
	}
}

func TestRestoreRecreatesMissingParent(t *testing.T) {
	e, dir := preparedUpdate(t)
	fakeSystemctl(t)
	fakeHealth(t, nil, nil)
	etc := filepath.Dir(e.workerEnv)
	if err := os.RemoveAll(etc); err != nil {
		t.Fatal(err)
	}
	if err := rollback(dir, "health", "x"); err != nil {
		t.Fatal(err)
	}
	if string(mustRead(t, e.workerEnv)) != "OLD=1\n" {
		t.Fatal("worker.env not restored")
	}
	st, err := os.Lstat(etc)
	if err != nil || !st.IsDir() || st.Mode().Perm() != 0o755 {
		t.Fatalf("parent recreated as %v %v", st, err)
	}
}

// symlinkedInstallRoot points HSI_INSTALL_DIR at a link to the real install dir.
func symlinkedInstallRoot(t *testing.T, e *updateEnv) string {
	t.Helper()
	link := filepath.Join(t.TempDir(), "opt-link")
	if err := os.Symlink(e.install, link); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HSI_INSTALL_DIR", link)
	return link
}

func TestPruneReleasesRefusesSymlinks(t *testing.T) {
	t.Run("install root", func(t *testing.T) {
		e := setupUpdateEnv(t)
		e.release(t, "v2.0.0", "v2.1.0", "v2.2.0", "v2.3.0")
		_ = switchCurrent("v2.3.0")
		symlinkedInstallRoot(t, e)
		pruneReleases(1)
		if _, err := os.Stat(filepath.Join(e.install, "releases", "v2.0.0")); err != nil {
			t.Fatal("removed a release through a symlinked install dir")
		}
	})
	t.Run("releases dir", func(t *testing.T) {
		e := setupUpdateEnv(t)
		real := t.TempDir()
		for _, v := range []string{"v2.0.0", "v2.1.0", "v2.2.0"} {
			_ = os.MkdirAll(filepath.Join(real, v, "bin"), 0o755)
		}
		_ = os.RemoveAll(filepath.Join(e.install, "releases"))
		if err := os.Symlink(real, filepath.Join(e.install, "releases")); err != nil {
			t.Fatal(err)
		}
		pruneReleases(0)
		if _, err := os.Stat(filepath.Join(real, "v2.0.0", "bin")); err != nil {
			t.Fatal("removed a release through a symlinked releases dir")
		}
	})
	t.Run("a release swapped for a link", func(t *testing.T) {
		e := setupUpdateEnv(t)
		e.release(t, "v2.1.0", "v2.2.0")
		_ = switchCurrent("v2.2.0")
		victim := t.TempDir()
		mustWrite(t, filepath.Join(victim, "keep"), []byte("x"))
		if err := os.Symlink(victim, filepath.Join(e.install, "releases", "v2.0.0")); err != nil {
			t.Fatal(err)
		}
		pruneReleases(0)
		if _, err := os.Stat(filepath.Join(victim, "keep")); err != nil {
			t.Fatal("followed a release link")
		}
		if _, err := os.Stat(filepath.Join(e.install, "releases", "v2.1.0")); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("a real old release was kept")
		}
	})
}

func TestSwitchCurrentRefusesSymlinkedInstallRoot(t *testing.T) {
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0")
	symlinkedInstallRoot(t, e)
	if err := switchCurrent("v2.0.0"); err == nil {
		t.Fatal("switched through a symlinked install dir")
	}
	if _, err := os.Lstat(filepath.Join(e.install, "current")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("created current through a symlinked install dir")
	}
}
