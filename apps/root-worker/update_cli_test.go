package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type tarEntry struct {
	name, body, link string
	kind             byte
	mode             int64
}

func buildArchive(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		h := &tar.Header{Name: e.name, Typeflag: e.kind, Mode: 0o644, Linkname: e.link}
		switch e.kind {
		case tar.TypeDir:
			h.Mode = 0o755
		case tar.TypeReg:
			h.Size = int64(len(e.body))
		}
		if e.mode != 0 {
			h.Mode = e.mode
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if e.kind == tar.TypeReg {
			_, _ = tw.Write([]byte(e.body))
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func goodArchive(t *testing.T, version string) []byte {
	root := "hsi-" + version
	return buildArchive(t, []tarEntry{
		{name: root + "/", kind: tar.TypeDir},
		{name: root + "/server.js", body: "console.log(1)", kind: tar.TypeReg},
		{name: root + "/node_modules/.bin/", kind: tar.TypeDir},
		{name: root + "/node_modules/.bin/prisma", link: "../prisma/index.js", kind: tar.TypeSymlink},
		{name: root + "/server2.js", link: root + "/server.js", kind: tar.TypeLink},
	})
}

// writeSignedRelease writes the four release files of version into dir, signed with the dev key.
func writeSignedRelease(t *testing.T, dir, version string, archive []byte) releaseFiles {
	t.Helper()
	f := releaseFiles{
		Sums:      filepath.Join(dir, "SHA256SUMS"),
		Sig:       filepath.Join(dir, "SHA256SUMS.sig"),
		Archive:   filepath.Join(dir, archiveName(version)),
		Installer: filepath.Join(dir, "install.sh"),
	}
	installer := []byte("#!/bin/bash\necho install\n")
	mustWrite(t, f.Archive, archive)
	mustWrite(t, f.Installer, installer)
	sums := []byte(sumLine(archive, archiveName(version)) + sumLine(installer, "install.sh"))
	mustWrite(t, f.Sums, sums)
	mustWrite(t, f.Sig, []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(devSigningKey(t), sums))+"\n"))
	return f
}

// fakeDownload makes downloadRelease write a signed release, then lets tamper change it.
func fakeDownload(t *testing.T, archive []byte, tamper func(releaseFiles)) {
	t.Helper()
	t.Setenv("HSI_ALLOW_DEV_SIGNING_KEY", "1")
	prev := downloadRelease
	downloadRelease = func(version, dir string) (releaseFiles, error) {
		f := writeSignedRelease(t, dir, version, archive)
		if tamper != nil {
			tamper(f)
		}
		return f, nil
	}
	t.Cleanup(func() { downloadRelease = prev })
}

type installerCall struct {
	path string
	env  []string
	body string
}

func fakeInstaller(t *testing.T, code int) *[]installerCall {
	t.Helper()
	var calls []installerCall
	prev := runInstaller
	runInstaller = func(path string, env []string) int {
		b, _ := os.ReadFile(path)
		archive := ""
		for _, kv := range env {
			if strings.HasPrefix(kv, "HSI_RELEASE_ARCHIVE=") {
				archive = strings.TrimPrefix(kv, "HSI_RELEASE_ARCHIVE=")
			}
		}
		if _, err := os.Stat(archive); err != nil {
			t.Errorf("the archive given to the installer is missing: %v", err)
		}
		calls = append(calls, installerCall{path: path, env: env, body: string(b)})
		return code
	}
	t.Cleanup(func() { runInstaller = prev })
	return &calls
}

func installerEnvValue(env []string, key string) (string, bool) {
	v := ""
	found := false
	for _, kv := range env {
		if strings.HasPrefix(kv, key+"=") {
			v, found = strings.TrimPrefix(kv, key+"="), true
		}
	}
	return v, found
}

func TestApplyRefusesUnverifiedWithoutChanges(t *testing.T) {
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0")
	if err := switchCurrent("v2.0.0"); err != nil {
		t.Fatal(err)
	}
	calls := fakeSystemctl(t)
	installs := fakeInstaller(t, 0)
	fakeDownload(t, goodArchive(t, "v2.1.0"), func(f releaseFiles) { mustWrite(t, f.Archive, []byte("tampered")) })

	if code := runUpdateCLI([]string{"apply", "v2.1.0"}); code == 0 {
		t.Fatal("a tampered release was applied")
	}
	if len(*installs) != 0 || len(*calls) != 0 || currentVersion() != "v2.0.0" {
		t.Fatalf("changed something: installs %d, systemctl %v, current %s", len(*installs), *calls, currentVersion())
	}
	if _, err := os.Stat(filepath.Join(e.install, "releases", "v2.1.0")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a release directory was created")
	}
	r, _ := readLast()
	if r == nil || r.Status != "refused" || r.From != "v2.0.0" || r.To != "v2.1.0" || !strings.Contains(r.Reason, "not authentic") {
		t.Fatalf("last %+v", r)
	}
	entries, _ := os.ReadDir(e.state)
	for _, en := range entries {
		if strings.HasPrefix(en.Name(), "apply-") {
			t.Fatalf("staging %s left behind", en.Name())
		}
	}
}

func TestApplyRunsTheVerifiedInstaller(t *testing.T) {
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0")
	_ = switchCurrent("v2.0.0")
	installs := fakeInstaller(t, 0)
	fakeDownload(t, goodArchive(t, "v2.1.0"), nil)
	t.Setenv("BACKEND_PORT", "9123")
	t.Setenv("VERSION", "v0.0.1")
	t.Setenv("HSI_ALLOW_UNSIGNED", "1")

	if code := runUpdateCLI([]string{"apply", "v2.1.0"}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if len(*installs) != 1 {
		t.Fatalf("installer runs %d", len(*installs))
	}
	c := (*installs)[0]
	if c.body != "#!/bin/bash\necho install\n" {
		t.Fatalf("ran %q", c.body)
	}
	if v, _ := installerEnvValue(c.env, "VERSION"); v != "v2.1.0" {
		t.Fatalf("VERSION=%q", v)
	}
	if v, _ := installerEnvValue(c.env, "BACKEND_PORT"); v != "9123" {
		t.Fatalf("BACKEND_PORT=%q", v)
	}
	if v, _ := installerEnvValue(c.env, "HSI_RELEASE_ARCHIVE"); filepath.Base(v) != archiveName("v2.1.0") {
		t.Fatalf("HSI_RELEASE_ARCHIVE=%q", v)
	}
	if _, ok := installerEnvValue(c.env, "HSI_ALLOW_UNSIGNED"); ok {
		t.Fatal("the dashboard path must never pass HSI_ALLOW_UNSIGNED")
	}
	if r, _ := readLast(); r != nil {
		t.Fatalf("apply wrote last.json itself: %+v", r)
	}
	entries, _ := os.ReadDir(e.state)
	for _, en := range entries {
		if strings.HasPrefix(en.Name(), "apply-") {
			t.Fatalf("staging %s left behind", en.Name())
		}
	}
	fakeInstaller(t, 3)
	if code := runUpdateCLI([]string{"apply", "v2.1.0"}); code != 3 {
		t.Fatalf("the installer exit code must be passed on, got %d", code)
	}
}

func TestApplyFromLocalArchive(t *testing.T) {
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0")
	_ = switchCurrent("v2.0.0")
	t.Setenv("HSI_ALLOW_DEV_SIGNING_KEY", "1")
	installs := fakeInstaller(t, 0)
	src := t.TempDir()
	f := writeSignedRelease(t, src, "v2.1.0", goodArchive(t, "v2.1.0"))
	if code := runUpdateCLI([]string{"apply", "v2.1.0", "--archive", f.Archive}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if len(*installs) != 1 || strings.HasPrefix((*installs)[0].path, src) {
		t.Fatalf("the installer must run from a private copy: %+v", *installs)
	}
	mustWrite(t, f.Installer, []byte("#!/bin/bash\nrm -rf /\n"))
	if code := runUpdateCLI([]string{"apply", "v2.1.0", "--archive", f.Archive}); code == 0 || len(*installs) != 1 {
		t.Fatal("a tampered local installer was run")
	}
}

func TestExtractReleaseRefusesUnsafeEntries(t *testing.T) {
	root := "hsi-v2.1.0"
	cases := map[string][]tarEntry{
		"parent path":       {{name: root + "/../x", body: "x", kind: tar.TypeReg}},
		"absolute path":     {{name: "/etc/x", body: "x", kind: tar.TypeReg}},
		"outside root":      {{name: "other/x", body: "x", kind: tar.TypeReg}},
		"escaping symlink":  {{name: root + "/l", link: "../../etc", kind: tar.TypeSymlink}},
		"absolute symlink":  {{name: root + "/l", link: "/etc", kind: tar.TypeSymlink}},
		"escaping hardlink": {{name: root + "/l", link: "/etc/passwd", kind: tar.TypeLink}},
		"write through link": {
			{name: root + "/d", link: ".", kind: tar.TypeSymlink},
			{name: root + "/d/x", body: "x", kind: tar.TypeReg},
		},
		"duplicate": {
			{name: root + "/x", body: "x", kind: tar.TypeReg},
			{name: root + "/x", body: "y", kind: tar.TypeReg},
		},
	}
	for name, entries := range cases {
		dir := t.TempDir()
		archive := filepath.Join(dir, "a.tar.gz")
		mustWrite(t, archive, buildArchive(t, entries))
		dest := filepath.Join(dir, "out")
		if err := extractRelease(archive, dest, root); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.tar.gz")
	mustWrite(t, archive, goodArchive(t, "v2.1.0"))
	dest := filepath.Join(dir, "out")
	if err := extractRelease(archive, dest, root); err != nil {
		t.Fatal(err)
	}
	if string(mustRead(t, filepath.Join(dest, "server2.js"))) != "console.log(1)" {
		t.Fatal("hard link not extracted")
	}
	if l, _ := os.Readlink(filepath.Join(dest, "node_modules", ".bin", "prisma")); l != "../prisma/index.js" {
		t.Fatalf("symlink %q", l)
	}
}

func TestManualRollbackNeedsTypedVersion(t *testing.T) {
	e, _ := preparedUpdate(t)
	clearInProgress()
	calls := fakeSystemctl(t)
	fakeHealth(t, nil, nil)
	prev := updateStdin
	t.Cleanup(func() { updateStdin = prev })

	updateStdin = strings.NewReader("v2.1.0\n")
	if code := runUpdateCLI([]string{"rollback"}); code != 1 {
		t.Fatalf("exit %d", code)
	}
	if len(*calls) != 0 || currentVersion() != "v2.1.0" || string(mustRead(t, e.db)) != "new db" {
		t.Fatalf("changed something: %v, current %s", *calls, currentVersion())
	}
	if r, _ := readLast(); r != nil {
		t.Fatalf("last written %+v", r)
	}

	updateStdin = strings.NewReader("v2.0.0\n")
	if code := runUpdateCLI([]string{"rollback"}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if currentVersion() != "v2.0.0" || string(mustRead(t, e.db)) != "old db" {
		t.Fatal("not rolled back")
	}
	if r, _ := readLast(); r == nil || r.Status != "rolled-back" || r.Step != "manual" {
		t.Fatalf("last %+v", r)
	}
}

func TestManualRollbackWithoutSnapshotRefused(t *testing.T) {
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0")
	_ = switchCurrent("v2.0.0")
	calls := fakeSystemctl(t)
	if code := runUpdateCLI([]string{"rollback", "--yes"}); code != 1 || len(*calls) != 0 {
		t.Fatalf("exit %d, calls %v", code, *calls)
	}
}

func TestScriptedRollbackUsesMarkerStep(t *testing.T) {
	_, dir := preparedUpdate(t)
	fakeSystemctl(t)
	fakeHealth(t, nil, nil)
	if code := runUpdateCLI([]string{"rollback", "--snapshot", dir, "--yes", "--reason", "the health checks failed"}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	r, _ := readLast()
	if r == nil || r.Status != "rolled-back" || r.Step != "health" || r.Reason != "the health checks failed" {
		t.Fatalf("last %+v", r)
	}
}

func TestUpdateStatusJSON(t *testing.T) {
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0", "v2.1.0", "v2.2.0")
	_ = switchCurrent("v2.2.0")
	created := time.Date(2026, 10, 20, 8, 0, 0, 0, time.UTC)
	snap := writeTestManifest(t, e, "v2.1.0", "v2.2.0", created)
	_ = writeLast(lastResult{From: "v2.1.0", To: "v2.2.0", Status: "success", At: created})

	var out bytes.Buffer
	prev := updateStdout
	updateStdout = &out
	t.Cleanup(func() { updateStdout = prev })
	if code := runUpdateCLI([]string{"status"}); code != 0 {
		t.Fatalf("exit %d", code)
	}
	var st struct {
		Last     map[string]any `json:"last"`
		Current  string         `json:"current"`
		Previous []struct {
			Version         string  `json:"version"`
			Snapshot        *string `json:"snapshot"`
			SnapshotCreated *string `json:"snapshotCreated"`
		} `json:"previous"`
	}
	if err := json.Unmarshal(out.Bytes(), &st); err != nil {
		t.Fatalf("%v: %s", err, out.String())
	}
	if st.Current != "v2.2.0" || st.Last["status"] != "success" || st.Last["from"] != "v2.1.0" {
		t.Fatalf("status %s", out.String())
	}
	if len(st.Previous) != 2 || st.Previous[0].Version != "v2.1.0" || st.Previous[1].Version != "v2.0.0" {
		t.Fatalf("previous %s", out.String())
	}
	if st.Previous[0].Snapshot == nil || *st.Previous[0].Snapshot != snap || st.Previous[0].SnapshotCreated == nil {
		t.Fatalf("snapshot of the previous version %s", out.String())
	}
	if st.Previous[1].Snapshot != nil {
		t.Fatalf("a version without snapshot %s", out.String())
	}

	// Nothing recorded yet: last is null, previous an empty list.
	setupUpdateEnv(t)
	out.Reset()
	runUpdateCLI([]string{"status"})
	if !strings.Contains(out.String(), `"last":null`) || !strings.Contains(out.String(), `"previous":[]`) {
		t.Fatalf("empty status %s", out.String())
	}
}

func TestMarkAndSwitchCLI(t *testing.T) {
	e := setupUpdateEnv(t)
	e.release(t, "v2.0.0", "v2.1.0")
	if code := runUpdateCLI([]string{"switch", "v2.1.0"}); code != 0 || currentVersion() != "v2.1.0" {
		t.Fatalf("switch exit %d, current %s", code, currentVersion())
	}
	snap := filepath.Join(e.state, "v2.0.0-v2.1.0")
	if code := runUpdateCLI([]string{"mark", "v2.0.0", "v2.1.0", snap, "migrate", "--pid", "4242"}); code != 0 {
		t.Fatalf("mark exit %d", code)
	}
	p, err := readInProgress()
	if err != nil || p == nil || p.Step != "migrate" || p.PID != 4242 || p.Snapshot != snap || p.Started.IsZero() {
		t.Fatalf("marker %+v %v", p, err)
	}
	started := p.Started
	time.Sleep(5 * time.Millisecond)
	runUpdateCLI([]string{"mark", "v2.0.0", "v2.1.0", snap, "health", "--pid", "4242"})
	if p, _ := readInProgress(); p.Step != "health" || !p.Started.Equal(started) {
		t.Fatalf("a step change must keep the start time: %+v", p)
	}
}
