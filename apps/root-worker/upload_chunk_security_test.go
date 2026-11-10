package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	nats "github.com/nats-io/nats.go"
	"golang.org/x/sys/unix"
)

func sendUploadChunkForTest(t *testing.T, destDir, uploadID string, offset int64, data []byte) {
	t.Helper()
	meta, err := json.Marshal(map[string]any{
		"uploadId":    uploadID,
		"offset":      offset,
		"destDir":     destDir,
		"allowedRoot": destDir,
	})
	if err != nil {
		t.Fatal(err)
	}
	msg := &nats.Msg{Header: nats.Header{"X-Meta": []string{string(meta)}}, Data: data}
	// nats.Conn.Publish returns ErrInvalidConnection for a nil connection, so
	// filesystem behavior is exercised without needing a running NATS server.
	handleWriteChunk(nil, msg)
}

func TestHandleWriteChunkRejectsSymlinkPartFile(t *testing.T) {
	root := t.TempDir()
	destDir := filepath.Join(root, "uploads")
	if err := os.Mkdir(destDir, 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "outside.txt")
	if err := os.WriteFile(outside, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	part := filepath.Join(destDir, ".upload-abc.part")
	if err := os.Symlink(outside, part); err != nil {
		t.Fatal(err)
	}

	sendUploadChunkForTest(t, destDir, "abc", 0, []byte("overwrite"))

	got, err := os.ReadFile(outside)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "keep me" {
		t.Fatalf("symlink target was modified: %q", got)
	}
}

func TestHandleWriteChunkRejectsHardLinkedPartFile(t *testing.T) {
	root := t.TempDir()
	destDir := filepath.Join(root, "uploads")
	if err := os.Mkdir(destDir, 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "outside.txt")
	if err := os.WriteFile(outside, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	part := filepath.Join(destDir, ".upload-abc.part")
	if err := os.Link(outside, part); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}

	sendUploadChunkForTest(t, destDir, "abc", 0, []byte("overwrite"))

	got, err := os.ReadFile(outside)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "keep me" {
		t.Fatalf("hard-link target was modified: %q", got)
	}
}

func TestHandleWriteChunkResumesRegularPartFile(t *testing.T) {
	t.Setenv("HSI_UPLOAD_STAGING", filepath.Join(t.TempDir(), "staging.json"))
	destDir := t.TempDir()
	part := filepath.Join(destDir, ".upload-abc.part")
	if err := os.WriteFile(part, []byte("old-chunk"), 0o600); err != nil {
		t.Fatal(err)
	}

	sendUploadChunkForTest(t, destDir, "abc", 4, []byte("NEW"))

	got, err := os.ReadFile(part)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "old-NEWnk" {
		t.Fatalf("resumed part contents = %q, want %q", got, "old-NEWnk")
	}
}

func TestHandleWriteChunkCreatesRegularPartFile(t *testing.T) {
	state := filepath.Join(t.TempDir(), "staging.json")
	t.Setenv("HSI_UPLOAD_STAGING", state)
	destDir := t.TempDir()
	part := filepath.Join(destDir, ".upload-new.part")

	sendUploadChunkForTest(t, destDir, "new", 0, []byte("first chunk"))

	info, err := os.Lstat(part)
	if err != nil {
		t.Fatal(err)
	}
	if !info.Mode().IsRegular() {
		t.Fatalf("created upload part has mode %v, want regular file", info.Mode())
	}
	got, err := os.ReadFile(part)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "first chunk" {
		t.Fatalf("new part contents = %q, want %q", got, "first chunk")
	}
	// Noted, so the sweep removes it if the upload is abandoned.
	if noted := newStagingRegistry(state).load(); len(noted) != 1 || noted[0] != (stagingEntry{Dir: destDir, ID: "new"}) {
		t.Fatalf("staging registry holds %+v, want this part", noted)
	}
}

func TestOpenRegularNoFollowAtRejectsFIFO(t *testing.T) {
	dir := t.TempDir()
	fifo := filepath.Join(dir, "part")
	if err := unix.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	dirFD, err := openScopedDirectory(dir, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(dirFD)

	f, err := openRegularNoFollowAt(dirFD, "part", unix.O_WRONLY, 0)
	if err == nil {
		f.Close()
		t.Fatal("expected FIFO to be rejected")
	}
	info, err := os.Lstat(fifo)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeNamedPipe == 0 {
		t.Fatalf("FIFO path changed to mode %v", info.Mode())
	}
}

func TestDoFinalizeRejectsSymlinkTempFile(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(root, "outside.txt")
	if err := os.WriteFile(outside, []byte("uploaded contents"), 0o600); err != nil {
		t.Fatal(err)
	}
	temp := filepath.Join(root, ".upload-abc.part")
	dest := filepath.Join(root, "final.txt")
	if err := os.Symlink(outside, temp); err != nil {
		t.Fatal(err)
	}

	if fsErr := doFinalize(temp, dest, root, ""); fsErr == nil {
		t.Fatal("expected symlink temp file to be rejected")
	}
	if _, err := os.Lstat(dest); !os.IsNotExist(err) {
		t.Fatalf("final destination was created from symlink: %v", err)
	}
	if _, err := os.Lstat(temp); err != nil {
		t.Fatalf("rejected temp symlink was unexpectedly removed: %v", err)
	}
}

func TestDoFinalizeRejectsHardLinkedTempFile(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(root, "outside.txt")
	if err := os.WriteFile(outside, []byte("uploaded contents"), 0o600); err != nil {
		t.Fatal(err)
	}
	temp := filepath.Join(root, ".upload-abc.part")
	dest := filepath.Join(root, "final.txt")
	if err := os.Link(outside, temp); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}

	if fsErr := doFinalize(temp, dest, root, ""); fsErr == nil {
		t.Fatal("expected hard-linked temp file to be rejected")
	}
	if _, err := os.Lstat(dest); !os.IsNotExist(err) {
		t.Fatalf("final destination was created from hard link: %v", err)
	}
}
