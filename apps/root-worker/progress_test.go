package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	nats "github.com/nats-io/nats.go"
)

func TestTreeSizeCountsRegularFilesOnly(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "d", "e"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(root, "d", "a"), make([]byte, 100), 0o644)
	_ = os.WriteFile(filepath.Join(root, "d", "e", "b"), make([]byte, 50), 0o644)
	_ = os.Symlink("/etc/passwd", filepath.Join(root, "d", "link"))
	if got := treeSize(filepath.Join(root, "d")); got != 150 {
		t.Fatalf("treeSize = %d, want 150 (links are not followed)", got)
	}
}

func TestCopyCountsItsBytes(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, filepath.Join(root, "src"), 3, 1000)
	p := &jobProgress{total: treeSize(filepath.Join(root, "src"))}
	ctx := withProgress(context.Background(), p)
	if err := os.MkdirAll(filepath.Join(root, "dst"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, fsErr := doCopy(ctx, filepath.Join(root, "src"), filepath.Join(root, "dst"), conflictRename); fsErr != nil {
		t.Fatal(fsErr)
	}
	if p.total != 3000 || p.done.Load() != 3000 {
		t.Fatalf("progress %d/%d, want 3000/3000", p.done.Load(), p.total)
	}
}

func TestUnzipTotalIsTheUncompressedSize(t *testing.T) {
	root := t.TempDir()
	archive := filepath.Join(root, "a.zip")
	f, _ := os.Create(archive)
	zw := zip.NewWriter(f)
	for _, name := range []string{"x.txt", "dir/y.txt"} {
		w, _ := zw.Create(name)
		_, _ = w.Write([]byte(strings.Repeat("z", 400)))
	}
	_ = zw.Close()
	f.Close()
	if got := zipContentSize(archive); got != 800 {
		t.Fatalf("zipContentSize = %d, want 800", got)
	}
	p := &jobProgress{total: 800}
	dst := filepath.Join(root, "out")
	_ = os.MkdirAll(dst, 0o755)
	if fsErr := doUnzip(withProgress(context.Background(), p), archive, dst); fsErr != nil {
		t.Fatal(fsErr)
	}
	if p.done.Load() != 800 {
		t.Fatalf("unzip counted %d bytes, want 800", p.done.Load())
	}
}

func TestProgressIsPublishedWhileItMoves(t *testing.T) {
	var events []jobEvent
	prev := publishEvent
	publishEvent = func(_ *nats.Conn, _ string, data []byte) error {
		var ev jobEvent
		_ = json.Unmarshal(data, &ev)
		events = append(events, ev)
		return nil
	}
	defer func() { publishEvent = prev }()

	p := &jobProgress{total: 1000}
	tick := make(chan time.Time)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() { reportProgressOn(nil, "j1", p, tick, stop); close(done) }()
	p.done.Add(400)
	tick <- time.Now()
	tick <- time.Now() // nothing new: no second event
	p.done.Add(100)
	tick <- time.Now()
	close(stop)
	<-done

	if len(events) != 2 {
		t.Fatalf("published %d events, want 2", len(events))
	}
	if events[0].Status != "progress" || events[0].Progress == nil || events[0].Progress.Done != 400 || events[0].Progress.Total != 1000 {
		t.Fatalf("first event %+v", events[0])
	}
	if events[1].Progress.Done != 500 {
		t.Fatalf("second event %+v", events[1])
	}
}
