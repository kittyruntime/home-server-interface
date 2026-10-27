package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadSkippedComposeSettings(t *testing.T) {
	if got, err := readSkippedComposeSettings(""); err != nil || got != nil {
		t.Fatalf("clean update: %v, %v", got, err)
	}
	path := filepath.Join(t.TempDir(), "skipped.json")
	good := `[{"application":"photos","setting":"volume /media","reason":"uses a deleted place and was skipped","remediation":"Choose an existing location."}]`
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
