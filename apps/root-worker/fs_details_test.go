package main

import (
	"context"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestStatExtras(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.json")
	if err := os.WriteFile(file, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "latest")
	if err := os.Symlink("notes.json", link); err != nil {
		t.Fatal(err)
	}

	st, fe := doStat(file)
	if fe != nil {
		t.Fatal(fe)
	}
	if st.Mime != "application/json" {
		t.Errorf("mime = %q, want application/json", st.Mime)
	}
	if st.Nlink != 1 || st.Atime == "" {
		t.Errorf("nlink = %d, atime = %q", st.Nlink, st.Atime)
	}

	ls, fe := doStat(link)
	if fe != nil {
		t.Fatal(fe)
	}
	if ls.LinkTarget != "notes.json" {
		t.Errorf("symlink target = %q", ls.LinkTarget)
	}
}

func TestDetectMimeSniffsWithoutExtension(t *testing.T) {
	file := filepath.Join(t.TempDir(), "README")
	if err := os.WriteFile(file, []byte("plain words"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := detectMime(file); got != "text/plain" {
		t.Errorf("mime = %q, want text/plain", got)
	}
}

func TestFolderSize(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "a", "b"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, size := range map[string]int{"x": 10, "a/y": 20, "a/b/z": 30} {
		if err := os.WriteFile(filepath.Join(dir, name), make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	r := folderSize(context.Background(), dir)
	if r.Files != 3 || r.Folders != 2 || r.Bytes != 60 || r.Partial {
		t.Errorf("folderSize = %+v", r)
	}

	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if !folderSize(ctx, dir).Partial {
		t.Error("an expired deadline must give a partial count")
	}
}

func TestChecksum(t *testing.T) {
	file := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(file, []byte("abc"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, fe := checksum(context.Background(), file)
	if fe != nil {
		t.Fatal(fe)
	}
	if r.Sha256 != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Errorf("sha256 = %s", r.Sha256)
	}
	if _, fe := checksum(context.Background(), filepath.Dir(file)); fe == nil || fe.Code != "EISDIR" {
		t.Errorf("a folder must be refused, got %v", fe)
	}
}

func TestMediaReadsImageSize(t *testing.T) {
	file := filepath.Join(t.TempDir(), "p.png")
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, image.NewRGBA(image.Rect(0, 0, 32, 18))); err != nil {
		t.Fatal(err)
	}
	f.Close()
	r, fe := media(context.Background(), file, userCtx{})
	if fe != nil {
		t.Fatal(fe)
	}
	if r.Width != 32 || r.Height != 18 {
		t.Errorf("media = %+v", r)
	}
}

func TestMountOf(t *testing.T) {
	info := `22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw
40 22 253:0 / /srv/data rw,relatime shared:20 - xfs /dev/mapper/vg-data rw
41 22 253:1 / /srv/my\040disk rw,relatime shared:21 - btrfs /dev/sdb1 rw`
	cases := map[string][2]string{
		"/srv/data/media/film.mkv": {"/srv/data", "/dev/mapper/vg-data"},
		"/srv/database":            {"/", "/dev/sda2"},
		"/srv/my disk/x":           {"/srv/my disk", "/dev/sdb1"},
	}
	for path, want := range cases {
		mp, src := mountOf(info, path)
		if mp != want[0] || src != want[1] {
			t.Errorf("mountOf(%q) = %q, %q; want %q, %q", path, mp, src, want[0], want[1])
		}
	}
	if fsTypeName(0x58465342) != "xfs" || fsTypeName(1) != "" {
		t.Error("fsTypeName")
	}
}

func TestSpecialFilesAreRefusedWithoutBlocking(t *testing.T) {
	dir := t.TempDir()
	fifo := filepath.Join(dir, "pipe")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Skip("mkfifo:", err)
	}
	done := make(chan *fsError, 1)
	go func() {
		_, fe := checksum(context.Background(), fifo)
		done <- fe
	}()
	select {
	case fe := <-done:
		if fe == nil {
			t.Fatal("a FIFO must be refused")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("checksum blocked on a FIFO")
	}
	if detectMime(fifo) != "" {
		t.Error("no MIME type for a FIFO")
	}

	target := filepath.Join(dir, "real")
	if err := os.WriteFile(target, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, fe := checksum(context.Background(), link); fe == nil {
		t.Error("a symlink is not followed for its checksum")
	}
}
