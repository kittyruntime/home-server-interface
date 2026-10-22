package main

import (
	"os"
	"path/filepath"
	"strings"
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
