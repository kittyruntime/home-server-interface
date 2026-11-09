package main

import (
	"archive/zip"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestCancelBeforeStartSkipsJob(t *testing.T) {
	r := newCancelRegistry()
	if running := r.cancel("j"); running {
		t.Fatal("a job not started yet is not running")
	}
	_, done, cancelled := r.begin("j")
	defer done()
	if !cancelled {
		t.Fatal("a job cancelled before it started must not run")
	}
}

func TestCancelRunningJobCancelsItsContext(t *testing.T) {
	r := newCancelRegistry()
	ctx, done, cancelled := r.begin("j")
	defer done()
	if cancelled {
		t.Fatal("not cancelled yet")
	}
	if !r.cancel("j") {
		t.Fatal("a started job is running")
	}
	if ctx.Err() == nil {
		t.Fatal("cancel must cancel the job's context")
	}
}

func TestCancelAfterEndIsNotRemembered(t *testing.T) {
	r := newCancelRegistry()
	_, done, _ := r.begin("j")
	done()
	r.cancel("j")
	_, done2, cancelled := r.begin("other")
	defer done2()
	if cancelled {
		t.Fatal("another job is not cancelled")
	}
}

func writeFiles(t *testing.T, dir string, n, size int) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, size)
	for i := 0; i < n; i++ {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%02d.bin", i)), buf, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func cancelledCtx() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

func TestCancelCopyRemovesOnlyItsOutput(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "Films")
	dst := filepath.Join(root, "Archives")
	writeFiles(t, src, 5, 1<<20)
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dst, "keep.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, fsErr := doCopy(cancelledCtx(), src, dst)
	if fsErr == nil || fsErr.Code != "ECANCELED" {
		t.Fatalf("got %v, want ECANCELED", fsErr)
	}
	if got := names(t, dst); len(got) != 1 || got[0] != "keep.txt" {
		t.Fatalf("destination holds %v, want only keep.txt", got)
	}
}

func TestCancelMoveAcrossDevicesKeepsTheSource(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "Films")
	writeFiles(t, src, 3, 1024)
	dst := filepath.Join(root, "Archives")
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	fsErr := moveByCopy(cancelledCtx(), src, filepath.Join(dst, "Films"))
	if fsErr == nil || fsErr.Code != "ECANCELED" {
		t.Fatalf("got %v, want ECANCELED", fsErr)
	}
	if got := names(t, src); len(got) != 3 {
		t.Fatalf("source holds %v, want its 3 files", got)
	}
	if got := names(t, dst); len(got) != 0 {
		t.Fatalf("destination holds %v, want nothing", got)
	}
}

func TestCancelZipRemovesPartialArchive(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "Projets")
	writeFiles(t, src, 3, 1024)
	fsErr := doZip(cancelledCtx(), []string{src}, root, "Projets.zip")
	if fsErr == nil || fsErr.Code != "ECANCELED" {
		t.Fatalf("got %v, want ECANCELED", fsErr)
	}
	if got := names(t, root); len(got) != 1 || got[0] != "Projets" {
		t.Fatalf("folder holds %v, want only the source", got)
	}
}

func TestCancelUnzipKeepsPreexistingFiles(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "a.zip")
	f, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for i := 0; i < 20; i++ {
		w, err := zw.Create(fmt.Sprintf("dir/sub%d/e%02d.txt", i%3, i))
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(w, "entry %d", i)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	f.Close()
	dst := filepath.Join(root, "out")
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dst, "old.txt"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	prev := afterUnzipEntry
	afterUnzipEntry = func(i int) {
		if i == 5 {
			cancel()
		}
	}
	defer func() { afterUnzipEntry = prev }()

	fsErr := doUnzip(ctx, archive, dst)
	if fsErr == nil || fsErr.Code != "ECANCELED" {
		t.Fatalf("got %v, want ECANCELED", fsErr)
	}
	if got := names(t, dst); len(got) != 1 || got[0] != "old.txt" {
		t.Fatalf("destination holds %v, want only old.txt", got)
	}
}

func TestCancelSingleFileCopyLeavesNoPartialFile(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "film.mkv")
	if err := os.WriteFile(src, make([]byte, 3<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(root, "Archives")
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	_, fsErr := doCopy(cancelledCtx(), src, dst)
	if fsErr == nil || fsErr.Code != "ECANCELED" {
		t.Fatalf("got %v, want ECANCELED", fsErr)
	}
	if got := names(t, dst); len(got) != 0 {
		t.Fatalf("destination holds %v, want nothing", got)
	}
}
