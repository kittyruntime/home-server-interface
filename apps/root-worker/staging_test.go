package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func stagingFixture(t *testing.T) (*stagingRegistry, string) {
	t.Helper()
	dir := t.TempDir()
	return newStagingRegistry(filepath.Join(dir, "state", "upload-staging.json")), dir
}

func touchPart(t *testing.T, dir, id string, age time.Duration) string {
	t.Helper()
	p := filepath.Join(dir, ".upload-"+id+".part")
	if err := os.WriteFile(p, []byte("partial"), 0o644); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(-age)
	if err := os.Chtimes(p, at, at); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestStagingSweepRemovesOnlyAbandonedParts(t *testing.T) {
	r, dir := stagingFixture(t)
	old := touchPart(t, dir, "old", 25*time.Hour)
	fresh := touchPart(t, dir, "fresh", time.Hour)
	r.note(dir, "old")
	r.note(dir, "fresh")

	if removed := r.sweep(24 * time.Hour); removed != 1 {
		t.Fatalf("removed %d, want 1", removed)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("a part untouched for 25 h must go")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("a part written an hour ago is an upload in progress: kept")
	}
}

func TestStagingSurvivesARestart(t *testing.T) {
	r, dir := stagingFixture(t)
	old := touchPart(t, dir, "old", 30*time.Hour)
	r.note(dir, "old")

	// The worker restarts: a new registry reads the same file.
	again := newStagingRegistry(r.path)
	if removed := again.sweep(24 * time.Hour); removed != 1 {
		t.Fatalf("removed %d after a restart, want 1", removed)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("the part noted before the restart must go")
	}
}

func TestStagingForgetsFinishedUploads(t *testing.T) {
	r, dir := stagingFixture(t)
	p := touchPart(t, dir, "done", time.Minute)
	r.note(dir, "done")
	if err := os.Remove(p); err != nil { // finalized or cancelled
		t.Fatal(err)
	}
	r.sweep(24 * time.Hour)
	if n := len(newStagingRegistry(r.path).load()); n != 0 {
		t.Fatalf("%d entries left, want none", n)
	}
}

func TestStagingNeverFollowsALink(t *testing.T) {
	r, dir := stagingFixture(t)
	target := filepath.Join(t.TempDir(), "precious")
	if err := os.WriteFile(target, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, ".upload-l.part")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(-48 * time.Hour)
	_ = os.Chtimes(target, at, at)
	r.note(dir, "l")
	r.sweep(24 * time.Hour)
	if _, err := os.Stat(target); err != nil {
		t.Fatal("the sweep followed a link")
	}
}
