package main

import (
	"os"
	"path/filepath"
	"testing"
)

// A file kept aside before a restore stays in place: a power cut between
// keeping it and writing the new one never leaves it missing.
func TestKeepAsideLeavesTheFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "tls.json")
	if err := os.WriteFile(p, []byte("old"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := keepAside(p, ".before-restore-x"); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(p); err != nil || string(b) != "old" {
		t.Fatalf("the file moved: %q %v", b, err)
	}
	st, err := os.Stat(p + ".before-restore-x")
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o640 {
		t.Fatalf("the copy has mode %o, want 640", st.Mode().Perm())
	}
	if b, _ := os.ReadFile(p + ".before-restore-x"); string(b) != "old" {
		t.Fatalf("the copy holds %q", b)
	}
	if err := keepAside(filepath.Join(dir, "missing"), ".x"); err != nil {
		t.Fatalf("a missing file is not an error: %v", err)
	}
}
