package main

import (
	"archive/zip"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

func writeZipEntry(t *testing.T, archivePath, name, content string, mode os.FileMode) {
	t.Helper()
	f, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	header := &zip.FileHeader{Name: name, Method: zip.Store}
	header.SetMode(mode)
	w, err := zw.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestDoCopyRejectsNestedSymlink(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "place", "source")
	dstDir := filepath.Join(root, "destination")
	outside := filepath.Join(root, "outside-secret.txt")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "a-regular.txt"), []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(src, "z-leak.txt")); err != nil {
		t.Fatal(err)
	}

	_, fsErr := doCopy(context.Background(), src, dstDir, conflictRename)
	if fsErr == nil || fsErr.Code != "EACCES" {
		t.Fatalf("expected symlink copy to fail with EACCES, got %#v", fsErr)
	}
	if _, err := os.Lstat(filepath.Join(dstDir, "source")); !os.IsNotExist(err) {
		t.Fatalf("partial copy was not cleaned up: %v", err)
	}
}

func TestDoZipRejectsNestedSymlink(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "place", "source")
	dstDir := filepath.Join(root, "destination")
	outside := filepath.Join(root, "outside-secret.txt")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(src, "leak.txt")); err != nil {
		t.Fatal(err)
	}

	fsErr := doZip(context.Background(), []string{src}, dstDir, "archive.zip")
	if fsErr == nil || fsErr.Code != "EACCES" {
		t.Fatalf("expected symlink zip to fail with EACCES, got %#v", fsErr)
	}
	if _, err := os.Lstat(filepath.Join(dstDir, "archive.zip")); !os.IsNotExist(err) {
		t.Fatalf("failed archive was not cleaned up: %v", err)
	}
}

func TestDoZipPreservesExistingArchiveWhenSourceFails(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "source")
	dstDir := filepath.Join(root, "destination")
	archivePath := filepath.Join(dstDir, "archive.zip")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "a-regular.txt"), []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "outside"), filepath.Join(src, "z-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(archivePath, []byte("existing archive"), 0o600); err != nil {
		t.Fatal(err)
	}

	fsErr := doZip(context.Background(), []string{src}, dstDir, "archive.zip")
	if fsErr == nil || fsErr.Code != "EACCES" {
		t.Fatalf("expected invalid source to fail with EACCES, got %#v", fsErr)
	}
	got, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "existing archive" {
		t.Fatalf("existing archive was modified on failure: %q", got)
	}
}

func TestDoZipCanReplaceASelectedDestinationFile(t *testing.T) {
	root := t.TempDir()
	archivePath := filepath.Join(root, "archive.zip")
	if err := os.WriteFile(archivePath, []byte("old contents"), 0o600); err != nil {
		t.Fatal(err)
	}
	if fsErr := doZip(context.Background(), []string{archivePath}, root, "archive.zip"); fsErr != nil {
		t.Fatalf("zip with destination as source failed: %#v", fsErr)
	}
	r, err := zip.OpenReader(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if len(r.File) != 1 || r.File[0].Name != "archive.zip" {
		t.Fatalf("unexpected archive entries: %#v", r.File)
	}
	rc, err := r.File[0].Open()
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	got, err := io.ReadAll(rc)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "old contents" {
		t.Fatalf("archived source changed during replacement: %q", got)
	}
}

func TestDoZipUsesSafeModeAndPreservesExistingMetadata(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "source.txt")
	archivePath := filepath.Join(root, "archive.zip")
	if err := os.WriteFile(src, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if fsErr := doZip(context.Background(), []string{src}, root, "archive.zip"); fsErr != nil {
		t.Fatalf("new zip failed: %#v", fsErr)
	}
	info, err := os.Stat(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o664 {
		t.Fatalf("new archive mode = %04o, want 0664", got)
	}
	if err := os.Chmod(archivePath, 0o640); err != nil {
		t.Fatal(err)
	}
	if fsErr := doZip(context.Background(), []string{src}, root, "archive.zip"); fsErr != nil {
		t.Fatalf("replacement zip failed: %#v", fsErr)
	}
	info, err = os.Stat(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o640 {
		t.Fatalf("replaced archive mode = %04o, want preserved 0640", got)
	}
}

func TestDoZipDoesNotTruncateThroughDestinationSymlink(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "source.txt")
	dstDir := filepath.Join(root, "destination")
	outside := filepath.Join(root, "outside.txt")
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, []byte("archive input"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("must survive"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dstDir, "archive.zip")); err != nil {
		t.Fatal(err)
	}

	fsErr := doZip(context.Background(), []string{src}, dstDir, "archive.zip")
	if fsErr == nil || fsErr.Code != "EACCES" {
		t.Fatalf("expected symlink destination to fail with EACCES, got %#v", fsErr)
	}
	got, err := os.ReadFile(outside)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "must survive" {
		t.Fatalf("outside file was modified through destination symlink: %q", got)
	}
}

func TestDoZipToTempRejectsNestedSymlink(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "shared-folder")
	outside := filepath.Join(root, "outside-secret.txt")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(src, "leak.txt")); err != nil {
		t.Fatal(err)
	}

	tmpPath, _, fsErr := doZipToTemp(src)
	if tmpPath != "" {
		_ = os.Remove(tmpPath)
		t.Fatalf("temporary archive was unexpectedly created: %s", tmpPath)
	}
	if fsErr == nil || fsErr.Code != "EACCES" {
		t.Fatalf("expected shared zip symlink to fail with EACCES, got %#v", fsErr)
	}
}

func TestDoUnzipRejectsSymlinkedDestinationParent(t *testing.T) {
	root := t.TempDir()
	dstDir := filepath.Join(root, "destination")
	outsideDir := filepath.Join(root, "outside")
	archivePath := filepath.Join(root, "payload.zip")
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideDir, filepath.Join(dstDir, "redirect")); err != nil {
		t.Fatal(err)
	}
	writeZipEntry(t, archivePath, "redirect/owned.txt", "owned", 0o644)

	fsErr := doUnzip(context.Background(), archivePath, dstDir)
	if fsErr == nil || fsErr.Code != "EACCES" {
		t.Fatalf("expected symlinked extraction path to fail with EACCES, got %#v", fsErr)
	}
	if _, err := os.Stat(filepath.Join(outsideDir, "owned.txt")); !os.IsNotExist(err) {
		t.Fatalf("archive wrote outside destination through symlink: %v", err)
	}
}

func TestDoUnzipRejectsSymlinkArchiveEntry(t *testing.T) {
	root := t.TempDir()
	dstDir := filepath.Join(root, "destination")
	archivePath := filepath.Join(root, "payload.zip")
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeZipEntry(t, archivePath, "link", "../../outside", os.ModeSymlink|0o777)

	fsErr := doUnzip(context.Background(), archivePath, dstDir)
	if fsErr == nil || fsErr.Code != "EACCES" {
		t.Fatalf("expected symlink archive entry to fail with EACCES, got %#v", fsErr)
	}
	if _, err := os.Lstat(filepath.Join(dstDir, "link")); !os.IsNotExist(err) {
		t.Fatalf("symlink archive entry was unexpectedly extracted: %v", err)
	}
}

func TestDoUnzipPrevalidatesBeforeWriting(t *testing.T) {
	root := t.TempDir()
	dstDir := filepath.Join(root, "destination")
	archivePath := filepath.Join(root, "payload.zip")
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	w, err := zw.Create("a-good.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("must not be extracted")); err != nil {
		t.Fatal(err)
	}
	header := &zip.FileHeader{Name: "z-link"}
	header.SetMode(os.ModeSymlink | 0o777)
	if _, err := zw.CreateHeader(header); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	fsErr := doUnzip(context.Background(), archivePath, dstDir)
	if fsErr == nil || fsErr.Code != "EACCES" {
		t.Fatalf("expected invalid archive to fail with EACCES, got %#v", fsErr)
	}
	if _, err := os.Lstat(filepath.Join(dstDir, "a-good.txt")); !os.IsNotExist(err) {
		t.Fatalf("archive wrote files before validation completed: %v", err)
	}
}

func TestDoUnzipRejectsSymlinkArchivePath(t *testing.T) {
	root := t.TempDir()
	dstDir := filepath.Join(root, "destination")
	realArchive := filepath.Join(root, "real.zip")
	archiveLink := filepath.Join(root, "linked.zip")
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeZipEntry(t, realArchive, "file.txt", "content", 0o644)
	if err := os.Symlink(realArchive, archiveLink); err != nil {
		t.Fatal(err)
	}
	fsErr := doUnzip(context.Background(), archiveLink, dstDir)
	if fsErr == nil || fsErr.Code != "EACCES" {
		t.Fatalf("expected symlink archive path to fail with EACCES, got %#v", fsErr)
	}
}

func TestDoUnzipUsesSafeModeAndPreservesExistingMetadata(t *testing.T) {
	root := t.TempDir()
	dstDir := filepath.Join(root, "destination")
	archivePath := filepath.Join(root, "payload.zip")
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeZipEntry(t, archivePath, "file.txt", "first", 0o777)
	if fsErr := doUnzip(context.Background(), archivePath, dstDir); fsErr != nil {
		t.Fatalf("new extraction failed: %#v", fsErr)
	}
	target := filepath.Join(dstDir, "file.txt")
	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o775 {
		t.Fatalf("new extracted mode = %04o, want safe 0775", got)
	}
	if err := os.Chmod(target, 0o640); err != nil {
		t.Fatal(err)
	}
	writeZipEntry(t, archivePath, "file.txt", "replacement", 0o777)
	if fsErr := doUnzip(context.Background(), archivePath, dstDir); fsErr != nil {
		t.Fatalf("replacement extraction failed: %#v", fsErr)
	}
	info, err = os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o640 {
		t.Fatalf("replaced extracted mode = %04o, want preserved 0640", got)
	}
}

func TestApplyReplacementMetadataPreservesOwnerAndClearsInheritedACL(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	temp := filepath.Join(root, "temp")
	if err := os.WriteFile(target, []byte("old"), 0o640); err != nil {
		t.Fatal(err)
	}
	metadata, err := replacementPolicy(target, 0o666)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.Fsetxattr(int(f.Fd()), "user.hsi-test", []byte("must not be copied as security metadata"), 0); err != nil &&
		!errors.Is(err, syscall.ENOTSUP) && !errors.Is(err, syscall.EOPNOTSUPP) {
		t.Fatal(err)
	}
	if err := applyReplacementMetadata(f, metadata); err != nil {
		f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	targetInfo, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	tempInfo, err := os.Stat(temp)
	if err != nil {
		t.Fatal(err)
	}
	targetStat := targetInfo.Sys().(*syscall.Stat_t)
	tempStat := tempInfo.Sys().(*syscall.Stat_t)
	if targetStat.Uid != tempStat.Uid || targetStat.Gid != tempStat.Gid {
		t.Fatalf("owner changed: target=%d:%d temp=%d:%d", targetStat.Uid, targetStat.Gid, tempStat.Uid, tempStat.Gid)
	}
	if tempInfo.Mode().Perm() != targetInfo.Mode().Perm() {
		t.Fatalf("mode changed: target=%04o temp=%04o", targetInfo.Mode().Perm(), tempInfo.Mode().Perm())
	}
}

func TestApplyReplacementMetadataClearsInheritedAccessACL(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	temp := filepath.Join(root, "temp")
	if err := os.WriteFile(target, []byte("old"), 0o640); err != nil {
		t.Fatal(err)
	}
	metadata, err := replacementPolicy(target, 0o666)
	if err != nil {
		t.Fatal(err)
	}
	if metadata.accessACL != nil {
		t.Skip("filesystem encoded a base ACL; absence case not available")
	}
	f, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	// Minimal extended access ACL: user::rw-, named uid 1:r--,
	// group::---, mask::r--, other::--- (little-endian Linux xattr format).
	acl := []byte{
		0x02, 0x00, 0x00, 0x00,
		0x01, 0x00, 0x06, 0x00, 0xff, 0xff, 0xff, 0xff,
		0x02, 0x00, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00,
		0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff,
		0x10, 0x00, 0x04, 0x00, 0xff, 0xff, 0xff, 0xff,
		0x20, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff,
	}
	if err := unix.Fsetxattr(int(f.Fd()), "system.posix_acl_access", acl, 0); err != nil {
		f.Close()
		if errors.Is(err, syscall.ENOTSUP) || errors.Is(err, syscall.EOPNOTSUPP) || errors.Is(err, syscall.EINVAL) {
			t.Skipf("POSIX ACLs unavailable: %v", err)
		}
		t.Fatal(err)
	}
	if err := applyReplacementMetadata(f, metadata); err != nil {
		f.Close()
		t.Fatal(err)
	}
	if _, err := unix.Fgetxattr(int(f.Fd()), "system.posix_acl_access", nil); !errors.Is(err, syscall.ENODATA) {
		f.Close()
		t.Fatalf("inherited access ACL was not removed: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestDoUnzipCannotReplaceReadOnlyFileThroughWritableParent(t *testing.T) {
	root := t.TempDir()
	dstDir := filepath.Join(root, "destination")
	archivePath := filepath.Join(root, "payload.zip")
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dstDir, "file.txt")
	if err := os.WriteFile(target, []byte("keep"), 0o444); err != nil {
		t.Fatal(err)
	}
	writeZipEntry(t, archivePath, "file.txt", "replace", 0o644)
	fsErr := doUnzip(context.Background(), archivePath, dstDir)
	if fsErr == nil || fsErr.Code != "EACCES" {
		t.Fatalf("expected read-only target replacement to fail with EACCES, got %#v", fsErr)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "keep" {
		t.Fatalf("read-only target was modified: %q", got)
	}
}

func TestDoZipAndUnzipStillHandleRegularFiles(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "source")
	archiveDir := filepath.Join(root, "archives")
	extractDir := filepath.Join(root, "extracted")
	for _, dir := range []string{src, archiveDir, extractDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(src, "regular.txt"), []byte("regular data"), 0o640); err != nil {
		t.Fatal(err)
	}
	if fsErr := doZip(context.Background(), []string{src}, archiveDir, "archive.zip"); fsErr != nil {
		t.Fatalf("regular zip failed: %#v", fsErr)
	}
	if fsErr := doUnzip(context.Background(), filepath.Join(archiveDir, "archive.zip"), extractDir); fsErr != nil {
		t.Fatalf("regular unzip failed: %#v", fsErr)
	}
	got, err := os.ReadFile(filepath.Join(extractDir, "source", "regular.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "regular data" {
		t.Fatalf("regular file content mismatch: %q", got)
	}
}
