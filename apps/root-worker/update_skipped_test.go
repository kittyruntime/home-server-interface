package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestReadSkippedComposeSettings(t *testing.T) {
	if got, err := readSkippedComposeSettings(""); err != nil || got != nil {
		t.Fatalf("clean update: %v, %v", got, err)
	}
	path := filepath.Join(t.TempDir(), "skipped.json")
	good := `[{"application":"photos","setting":"volume /media","reason":"the Place it used was deleted","remediation":"Choose an existing Place."}]`
	if err := os.WriteFile(path, []byte(good), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readSkippedComposeSettings(path)
	if err != nil || len(got) != 1 || got[0].Application != "photos" {
		t.Fatalf("skip report: %v, %v", got, err)
	}
	if err := os.WriteFile(path, []byte(`[{"application":"photos"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readSkippedComposeSettings(path); err == nil {
		t.Fatal("accepted missing reason and remediation")
	}
}

func TestReadSkippedComposeSettingsRejectsUnsafeFiles(t *testing.T) {
	good := `[{"application":"photos","setting":"volume /media","reason":"deleted Place","remediation":"Choose an existing Place."}]`
	for _, name := range []string{"symlink", "fifo", "oversized", "parent symlink"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "skipped.json")
			switch name {
			case "symlink":
				target := filepath.Join(dir, "target.json")
				if err := os.WriteFile(target, []byte(good), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := syscall.Mkfifo(path, 0o600); err != nil {
					t.Fatal(err)
				}
			case "oversized":
				if err := os.WriteFile(path, []byte(good+strings.Repeat(" ", 1024*1024)), 0o600); err != nil {
					t.Fatal(err)
				}
			case "parent symlink":
				real := filepath.Join(dir, "real")
				if err := os.Mkdir(real, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(real, "skipped.json"), []byte(good), 0o600); err != nil {
					t.Fatal(err)
				}
				link := filepath.Join(dir, "link")
				if err := os.Symlink(real, link); err != nil {
					t.Fatal(err)
				}
				path = filepath.Join(link, "skipped.json")
			}
			if got, err := readSkippedComposeSettings(path); err == nil {
				t.Fatalf("accepted unsafe %s: %+v", name, got)
			}
		})
	}
}
