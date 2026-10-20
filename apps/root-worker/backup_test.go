package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRsyncBackupLocalCopyAndMirror(t *testing.T) {
	if _, err := os.Stat("/usr/bin/rsync"); err != nil {
		t.Skip("rsync is not installed")
	}
	root := t.TempDir()
	source, destination := filepath.Join(root, "source"), filepath.Join(root, "destination")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(destination, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "kept.txt"), []byte("backup data"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(destination, "stale.txt"), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := runRsync(taskMsg{Direction: "push", Source: source, Destination: destination, DeleteExtra: true}); err != nil {
		t.Fatalf("backup failed: %s", err)
	}
	if got, err := os.ReadFile(filepath.Join(destination, "kept.txt")); err != nil || string(got) != "backup data" {
		t.Fatalf("copied file mismatch: %q, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(destination, "stale.txt")); !os.IsNotExist(err) {
		t.Fatalf("mirror did not remove stale file: %v", err)
	}
}

func TestRsyncBackupRejectsFilesystemRoot(t *testing.T) {
	if _, err := runRsync(taskMsg{Direction: "push", Source: "/", Destination: t.TempDir()}); err == nil {
		t.Fatal("expected filesystem root to be rejected")
	}
}
