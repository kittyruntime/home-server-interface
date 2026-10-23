package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// Fixes of the final review of safe updates (#9a).

func TestSwitchCurrentRefusesUntrustedRelease(t *testing.T) {
	cases := map[string]func(t *testing.T, rel string){
		"group-writable release": func(t *testing.T, rel string) {
			if err := os.Chmod(rel, 0o775); err != nil {
				t.Fatal(err)
			}
		},
		"other-writable bin": func(t *testing.T, rel string) {
			if err := os.Chmod(filepath.Join(rel, "bin"), 0o757); err != nil {
				t.Fatal(err)
			}
		},
		"group-writable worker": func(t *testing.T, rel string) {
			if err := os.Chmod(filepath.Join(rel, "bin", "hsi-worker"), 0o775); err != nil {
				t.Fatal(err)
			}
		},
		"setuid worker": func(t *testing.T, rel string) {
			if err := os.Chmod(filepath.Join(rel, "bin", "hsi-worker"), os.ModeSetuid|0o755); err != nil {
				t.Fatal(err)
			}
		},
		"worker is a link": func(t *testing.T, rel string) {
			w := filepath.Join(rel, "bin", "hsi-worker")
			if err := os.Remove(w); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink("/bin/sh", w); err != nil {
				t.Fatal(err)
			}
		},
		"release of another user": func(t *testing.T, rel string) {
			prev := releaseOwnerUID
			releaseOwnerUID = func() int { return os.Geteuid() + 1 }
			t.Cleanup(func() { releaseOwnerUID = prev })
		},
	}
	for name, spoil := range cases {
		t.Run(name, func(t *testing.T) {
			e := setupUpdateEnv(t)
			e.release(t, "v2.0.0", "v2.1.0")
			for _, v := range []string{"v2.0.0", "v2.1.0"} {
				rel := filepath.Join(e.install, "releases", v)
				if err := os.Mkdir(filepath.Join(rel, "bin"), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(rel, "bin", "hsi-worker"), []byte("#!/bin/sh\n"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			if err := switchCurrent("v2.0.0"); err != nil {
				t.Fatal(err)
			}
			spoil(t, filepath.Join(e.install, "releases", "v2.1.0"))
			err := switchCurrent("v2.1.0")
			if err == nil || !strings.Contains(err.Error(), "refusing") {
				t.Fatalf("want a refusal, got %v", err)
			}
			if currentVersion() != "v2.0.0" {
				t.Fatalf("current moved to %q", currentVersion())
			}
		})
	}
}

func TestSwitchCurrentAcceptsReleaseWithoutWorker(t *testing.T) {
	e := setupUpdateEnv(t)
	e.release(t, "v0.0.0-flat")
	if err := switchCurrent("v0.0.0-flat"); err != nil {
		t.Fatal(err)
	}
}

// pendingEnv is a host with v2.0.0 current, the update request marker at HSI_PENDING_UPDATE
// and a fake download and installer.
func pendingEnv(t *testing.T) (marker string, installs *[]installerCall) {
	t.Helper()
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0")
	if err := switchCurrent("v2.0.0"); err != nil {
		t.Fatal(err)
	}
	marker = filepath.Join(filepath.Dir(e.db), ".pending-update")
	t.Setenv("HSI_PENDING_UPDATE", marker)
	installs = fakeInstaller(t, 0)
	fakeDownload(t, goodArchive(t, "v2.1.0"), nil)
	return marker, installs
}

func TestApplyPendingReadsTheMarkerItself(t *testing.T) {
	marker, installs := pendingEnv(t)
	mustWrite(t, marker, []byte("v2.1.0"))
	if code := runUpdateCLI([]string{"apply-pending"}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if len(*installs) != 1 {
		t.Fatalf("installer runs %d", len(*installs))
	}
	if v, _ := installerEnvValue((*installs)[0].env, "VERSION"); v != "v2.1.0" {
		t.Fatalf("VERSION=%q", v)
	}
	if _, err := os.Lstat(marker); !os.IsNotExist(err) {
		t.Fatal("the marker was not removed")
	}
	if code := runUpdateCLI([]string{"apply-pending", "v2.1.0"}); code != 2 {
		t.Fatalf("apply-pending takes no version, exit %d", code)
	}
}

func TestApplyPendingNeverReadsThroughALink(t *testing.T) {
	marker, installs := pendingEnv(t)
	secret := filepath.Join(t.TempDir(), "secret")
	mustWrite(t, secret, []byte("v2.1.0 SECRET-ROOT-DATA"))
	if err := os.Symlink(secret, marker); err != nil {
		t.Fatal(err)
	}
	if code := runUpdateCLI([]string{"apply-pending"}); code == 0 {
		t.Fatal("a marker that is a link was applied")
	}
	if len(*installs) != 0 {
		t.Fatal("the installer ran")
	}
	if _, err := os.Lstat(marker); !os.IsNotExist(err) {
		t.Fatal("the link was not removed")
	}
	if b, _ := os.ReadFile(secret); string(b) != "v2.1.0 SECRET-ROOT-DATA" {
		t.Fatal("the link target changed")
	}
	assertLastRefusedWithout(t, "SECRET")
}

func TestApplyPendingRefusesOddMarkers(t *testing.T) {
	cases := map[string]func(t *testing.T, marker string){
		"fifo": func(t *testing.T, marker string) {
			if err := syscall.Mkfifo(marker, 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"hard link": func(t *testing.T, marker string) {
			other := filepath.Join(filepath.Dir(marker), "other")
			mustWrite(t, other, []byte("v2.1.0"))
			if err := os.Link(other, marker); err != nil {
				t.Fatal(err)
			}
		},
		"folder": func(t *testing.T, marker string) {
			if err := os.Mkdir(marker, 0o755); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, plant := range cases {
		t.Run(name, func(t *testing.T) {
			marker, installs := pendingEnv(t)
			plant(t, marker)
			if code := runUpdateCLI([]string{"apply-pending"}); code == 0 || len(*installs) != 0 {
				t.Fatalf("applied a %s marker", name)
			}
			assertLastRefusedWithout(t, "SECRET")
		})
	}
}

func TestApplyPendingNeverStoresAnInvalidVersion(t *testing.T) {
	for name, body := range map[string]string{
		"content of another file": "root:x:0:0:SECRET:/root:/bin/bash\n",
		"longer than 64 bytes":    "v2.1.0" + strings.Repeat("SECRET", 20),
	} {
		t.Run(name, func(t *testing.T) {
			marker, installs := pendingEnv(t)
			mustWrite(t, marker, []byte(body))
			if code := runUpdateCLI([]string{"apply-pending"}); code == 0 || len(*installs) != 0 {
				t.Fatal("an invalid request was applied")
			}
			r := assertLastRefusedWithout(t, "SECRET")
			if r.To != "" || r.Reason != "invalid version requested" {
				t.Fatalf("last %+v", r)
			}
		})
	}
	// The same for `update apply <version>`.
	setupUpdateEnv(t)
	if code := runUpdateCLI([]string{"apply", "vSECRET"}); code == 0 {
		t.Fatal("an invalid version was applied")
	}
	if r := assertLastRefusedWithout(t, "SECRET"); r.Reason != "invalid version requested" {
		t.Fatalf("last %+v", r)
	}
}

func assertLastRefusedWithout(t *testing.T, leak string) *lastResult {
	t.Helper()
	r, err := readLast()
	if err != nil || r == nil || r.Status != "refused" {
		t.Fatalf("last %+v, %v", r, err)
	}
	b, _ := os.ReadFile(filepath.Join(updateStateDir(), "last.json"))
	if strings.Contains(string(b), leak) {
		t.Fatalf("last.json holds the marker content: %s", b)
	}
	return r
}

// stagedRepair is releases/v2.0.0 (current, file "old") and releases/.staging-77 (file "new").
func stagedRepair(t *testing.T) *updateEnv {
	t.Helper()
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0", ".staging-77")
	mustWrite(t, filepath.Join(e.install, "releases", "v2.0.0", "server.js"), []byte("old"))
	mustWrite(t, filepath.Join(e.install, "releases", ".staging-77", "server.js"), []byte("new"))
	if err := switchCurrent("v2.0.0"); err != nil {
		t.Fatal(err)
	}
	return e
}

func TestReplaceSwapsTheLiveReleaseAtomically(t *testing.T) {
	e := stagedRepair(t)
	live := filepath.Join(e.install, "releases", "v2.0.0")
	var missing atomic.Bool
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
			}
			if _, err := os.Stat(filepath.Join(e.install, "current", "server.js")); err != nil {
				missing.Store(true)
			}
		}
	}()
	code := runUpdateCLI([]string{"replace", "v2.0.0", ".staging-77"})
	close(stop)
	<-done
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if b, _ := os.ReadFile(filepath.Join(live, "server.js")); string(b) != "new" {
		t.Fatalf("live release holds %q", b)
	}
	if _, err := os.Lstat(filepath.Join(e.install, "releases", ".staging-77")); !os.IsNotExist(err) {
		t.Fatal("the previous copy was not removed")
	}
	if missing.Load() {
		t.Fatal("the live release was missing during the replace")
	}
	if currentVersion() != "v2.0.0" {
		t.Fatalf("current %q", currentVersion())
	}
}

func TestReplaceRefusesBadOrUntrustedStaging(t *testing.T) {
	e := stagedRepair(t)
	for _, args := range [][]string{
		{"replace", "v2.0.0", "../v2.0.0"},
		{"replace", "v2.0.0", "v2.1.0"},
		{"replace", "v2.0.0", ".staging-x"},
		{"replace", "../etc", ".staging-77"},
		{"replace", "v2.1.0", ".staging-77"},
	} {
		if code := runUpdateCLI(args); code == 0 {
			t.Errorf("%v accepted", args)
		}
	}
	if err := os.Chmod(filepath.Join(e.install, "releases", ".staging-77"), 0o777); err != nil {
		t.Fatal(err)
	}
	if code := runUpdateCLI([]string{"replace", "v2.0.0", ".staging-77"}); code == 0 {
		t.Fatal("an untrusted staging copy replaced the live release")
	}
	if b, _ := os.ReadFile(filepath.Join(e.install, "releases", "v2.0.0", "server.js")); string(b) != "old" {
		t.Fatalf("live release changed to %q", b)
	}
}

func TestLatestSnapshotSkipsSameVersion(t *testing.T) {
	e := setupUpdateEnv(t)
	e.release(t, "v1.9.0", "v2.0.0")
	writeTestManifest(t, e, "v1.9.0", "v2.0.0", time.Now().Add(-time.Hour))
	writeTestManifest(t, e, "v2.0.0", "v2.0.0", time.Now())
	s, ok := latestSnapshotFor("v2.0.0")
	if !ok || s.Manifest.From != "v1.9.0" {
		t.Fatalf("latest %+v %v", s.Manifest, ok)
	}
}

func statusJSON(t *testing.T) map[string]any {
	t.Helper()
	var out bytes.Buffer
	prev := updateStdout
	updateStdout = &out
	t.Cleanup(func() { updateStdout = prev })
	if code := runUpdateCLI([]string{"status"}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	var st map[string]any
	if err := json.Unmarshal(out.Bytes(), &st); err != nil {
		t.Fatalf("%v: %s", err, out.String())
	}
	return st
}

// The status names the version `update rollback` would bring back, which is not
// always the newest previous version.
func TestUpdateStatusReportsTheRollbackTarget(t *testing.T) {
	e := setupUpdateEnv(t)
	t.Setenv("HSI_UNIT_PREFIX", "nas")
	e.release(t, "v2.0.0", "v2.1.0", "v2.2.0")
	_ = switchCurrent("v2.2.0")
	created := time.Date(2026, 10, 20, 8, 0, 0, 0, time.UTC)
	snap := writeTestManifest(t, e, "v2.0.0", "v2.2.0", created)
	writeTestManifest(t, e, "v2.2.0", "v2.2.0", created.Add(time.Hour))
	st := statusJSON(t)
	target, ok := st["rollbackTarget"].(map[string]any)
	if !ok || target["version"] != "v2.0.0" || target["snapshot"] != snap || target["snapshotCreated"] != "2026-10-20T08:00:00Z" {
		t.Fatalf("rollbackTarget %v", st["rollbackTarget"])
	}
	if prev := st["previous"].([]any); prev[0].(map[string]any)["version"] != "v2.1.0" {
		t.Fatalf("previous %v", prev)
	}
	if st["rollbackCommand"] != "sudo nas-worker update rollback" {
		t.Fatalf("rollbackCommand %v", st["rollbackCommand"])
	}

	setupUpdateEnv(t)
	e.release(t, "v2.0.0")
	if st := statusJSON(t); st["rollbackTarget"] != nil {
		t.Fatalf("rollbackTarget without snapshot %v", st["rollbackTarget"])
	}
}

// The worker verifies the signed files and leaves extraction to the installer, which
// checks the archive layout itself: no second extracted copy of the release.
func TestApplyDoesNotExtractTheArchive(t *testing.T) {
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0")
	_ = switchCurrent("v2.0.0")
	fakeDownload(t, goodArchive(t, "v2.1.0"), nil)
	var entries []string
	prev := runInstaller
	runInstaller = func(path string, env []string) int {
		archive, _ := installerEnvValue(env, "HSI_RELEASE_ARCHIVE")
		stage := filepath.Dir(filepath.Dir(archive))
		des, _ := os.ReadDir(stage)
		for _, d := range des {
			entries = append(entries, d.Name())
		}
		return 0
	}
	t.Cleanup(func() { runInstaller = prev })
	if code := runUpdateCLI([]string{"apply", "v2.1.0"}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if strings.Join(entries, ",") != "download" {
		t.Fatalf("staging holds %v", entries)
	}
}

// version_lt in scripts/install.sh (the installer's version floor) orders versions
// the way compareVersions does (the worker's firstHealthVersion and pruning).
func TestInstallerVersionOrderMatchesCompareVersions(t *testing.T) {
	versions := []string{"v1.67.0", "v1.67.0-rc1", "v1.67.0-rc2", "v1.67.0-beta", "v1.66.9", "v1.67.1",
		"v1.68.0-rc1", "v2.0.0", "v0.0.0-flat", "v1.10.0", "v1.9.0", "v1.67.0-Z", "v1.67.0-a"}
	var script strings.Builder
	script.WriteString(`set -u
sed -n '/^# BEGIN release functions/,/^# END release functions/p' ../../scripts/install.sh > "$1"
source "$1"
`)
	for _, a := range versions {
		for _, b := range versions {
			fmt.Fprintf(&script, "version_lt %s %s && echo '%s<%s' || echo '%s>=%s'\n", a, b, a, b, a, b)
		}
	}
	cmd := exec.Command("bash", "-c", script.String(), "bash", filepath.Join(t.TempDir(), "func.sh"))
	cmd.Env = append(os.Environ(), "LC_ALL=en_US.UTF-8")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	i := 0
	for _, a := range versions {
		for _, b := range versions {
			want := a + ">=" + b
			if compareVersions(a, b) < 0 {
				want = a + "<" + b
			}
			if i >= len(lines) || lines[i] != want {
				got := "nothing"
				if i < len(lines) {
					got = lines[i]
				}
				t.Errorf("version_lt says %s, compareVersions %s", got, want)
			}
			i++
		}
	}
}

// A database rename that fails after the journals were set aside puts them back.
func TestRestoreDatabaseKeepsJournalsWhenTheCommitFails(t *testing.T) {
	e, dir := preparedUpdate(t)
	mustWrite(t, e.db+"-shm", []byte("new shm"))
	prev := renameat
	renameat = func(od int, op string, nd int, np string) error {
		if np == filepath.Base(e.db) {
			return syscall.EIO
		}
		return prev(od, op, nd, np)
	}
	t.Cleanup(func() { renameat = prev })
	m, err := readManifest(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := restoreDatabase(dir, m); err == nil {
		t.Fatal("the restore succeeded")
	}
	for p, want := range map[string]string{e.db: "new db", e.db + "-wal": "new wal", e.db + "-shm": "new shm"} {
		if b, err := os.ReadFile(p); err != nil || string(b) != want {
			t.Fatalf("%s holds %q (%v), want %q", filepath.Base(p), b, err, want)
		}
	}
	entries, _ := os.ReadDir(filepath.Dir(e.db))
	for _, en := range entries {
		if strings.Contains(en.Name(), "hsi-tmp") || strings.Contains(en.Name(), "hsi-old") {
			t.Fatalf("leftover %s", en.Name())
		}
	}
	// Without the failure the journals of the version rolled back from are gone.
	renameat = prev
	if err := restoreDatabase(dir, m); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(e.db + "-shm"); !os.IsNotExist(err) {
		t.Fatal("the -shm of the version rolled back from was kept")
	}
	if b, _ := os.ReadFile(e.db); string(b) != "old db" {
		t.Fatalf("db %q", b)
	}
	entries, _ = os.ReadDir(filepath.Dir(e.db))
	for _, en := range entries {
		if strings.Contains(en.Name(), "hsi-old") {
			t.Fatalf("leftover %s", en.Name())
		}
	}
}

// A folder a rollback recreates is named in its errors for what it is.
func TestRestoreFolderNames(t *testing.T) {
	e := setupUpdateEnv(t)
	for src, want := range map[string]string{
		filepath.Join(e.systemd, "hsi-server.service"): "the systemd unit folder",
		e.workerEnv: "the configuration folder of worker.env",
	} {
		if got := restoreFolderName(src); got != want {
			t.Errorf("%s: %q, want %q", src, got, want)
		}
	}
}
