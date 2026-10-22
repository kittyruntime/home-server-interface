package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
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
