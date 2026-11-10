package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func mkTree(t *testing.T, dir string, files ...string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if err := os.WriteFile(filepath.Join(dir, f), []byte(f), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCopyReplaceSwapsTheExistingItem(t *testing.T) {
	root := t.TempDir()
	mkTree(t, filepath.Join(root, "src", "Films"), "new.txt")
	mkTree(t, filepath.Join(root, "dst", "Films"), "old.txt")
	res, fsErr := doCopy(context.Background(), filepath.Join(root, "src", "Films"), filepath.Join(root, "dst"), conflictReplace)
	if fsErr != nil {
		t.Fatal(fsErr)
	}
	if res.Dst != filepath.Join(root, "dst", "Films") {
		t.Fatalf("copied to %s", res.Dst)
	}
	if got := names(t, filepath.Join(root, "dst", "Films")); len(got) != 1 || got[0] != "new.txt" {
		t.Fatalf("Films holds %v, want only new.txt", got)
	}
	if got := names(t, filepath.Join(root, "dst")); len(got) != 1 {
		t.Fatalf("dst holds %v, want only Films (no leftover)", got)
	}
}

func TestCopyReplaceCancelledKeepsTheExistingItem(t *testing.T) {
	root := t.TempDir()
	mkTree(t, filepath.Join(root, "src", "Films"), "new.txt")
	mkTree(t, filepath.Join(root, "dst", "Films"), "old.txt")
	_, fsErr := doCopy(cancelledCtx(), filepath.Join(root, "src", "Films"), filepath.Join(root, "dst"), conflictReplace)
	if fsErr == nil || fsErr.Code != "ECANCELED" {
		t.Fatalf("got %v, want ECANCELED", fsErr)
	}
	if got := names(t, filepath.Join(root, "dst", "Films")); len(got) != 1 || got[0] != "old.txt" {
		t.Fatalf("Films holds %v, want the old content kept", got)
	}
	if got := names(t, filepath.Join(root, "dst")); len(got) != 1 {
		t.Fatalf("dst holds %v, want no leftover", got)
	}
}

func TestCopyKeepBothStillNumbers(t *testing.T) {
	root := t.TempDir()
	mkTree(t, filepath.Join(root, "src", "Films"), "new.txt")
	mkTree(t, filepath.Join(root, "dst", "Films"), "old.txt")
	res, fsErr := doCopy(context.Background(), filepath.Join(root, "src", "Films"), filepath.Join(root, "dst"), conflictRename)
	if fsErr != nil {
		t.Fatal(fsErr)
	}
	if filepath.Base(res.Dst) != "Films (1)" {
		t.Fatalf("copied to %s, want Films (1)", res.Dst)
	}
}

func TestCopySkipLeavesEverything(t *testing.T) {
	root := t.TempDir()
	mkTree(t, filepath.Join(root, "src", "Films"), "new.txt")
	mkTree(t, filepath.Join(root, "dst", "Films"), "old.txt")
	if _, fsErr := doCopy(context.Background(), filepath.Join(root, "src", "Films"), filepath.Join(root, "dst"), conflictSkip); fsErr != nil {
		t.Fatal(fsErr)
	}
	if got := names(t, filepath.Join(root, "dst", "Films")); len(got) != 1 || got[0] != "old.txt" {
		t.Fatalf("Films holds %v, want it untouched", got)
	}
}

func TestMoveReplaceSwapsTheExistingItem(t *testing.T) {
	root := t.TempDir()
	mkTree(t, filepath.Join(root, "src", "Films"), "new.txt")
	mkTree(t, filepath.Join(root, "dst", "Films"), "old.txt")
	if _, fsErr := doMove(context.Background(), filepath.Join(root, "src", "Films"), filepath.Join(root, "dst"), conflictReplace); fsErr != nil {
		t.Fatal(fsErr)
	}
	if got := names(t, filepath.Join(root, "dst", "Films")); len(got) != 1 || got[0] != "new.txt" {
		t.Fatalf("Films holds %v, want only new.txt", got)
	}
	if _, err := os.Stat(filepath.Join(root, "src", "Films")); !os.IsNotExist(err) {
		t.Fatal("the source must be gone after a move")
	}
	if got := names(t, filepath.Join(root, "dst")); len(got) != 1 {
		t.Fatalf("dst holds %v, want no leftover", got)
	}
}

func TestMoveWithoutAChoiceStillRefusesAnExistingName(t *testing.T) {
	root := t.TempDir()
	mkTree(t, filepath.Join(root, "src", "Films"), "new.txt")
	mkTree(t, filepath.Join(root, "dst", "Films"), "old.txt")
	_, fsErr := doMove(context.Background(), filepath.Join(root, "src", "Films"), filepath.Join(root, "dst"), "")
	if fsErr == nil || fsErr.Code != "EEXIST" {
		t.Fatalf("got %v, want EEXIST", fsErr)
	}
}

func TestReplaceNeverRemovesTheSourceItself(t *testing.T) {
	root := t.TempDir()
	// Moving dst/Films/Films up into dst would replace its own parent.
	mkTree(t, filepath.Join(root, "dst", "Films", "Films"), "inner.txt")
	_, fsErr := doMove(context.Background(), filepath.Join(root, "dst", "Films", "Films"), filepath.Join(root, "dst"), conflictReplace)
	if fsErr == nil {
		t.Fatal("replacing the folder that holds the source must be refused")
	}
	if got := names(t, filepath.Join(root, "dst", "Films", "Films")); len(got) != 1 {
		t.Fatalf("source holds %v, want it untouched", got)
	}
}
