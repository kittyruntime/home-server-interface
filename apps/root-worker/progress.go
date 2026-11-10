package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"path/filepath"
	"sync/atomic"
	"time"

	nats "github.com/nats-io/nats.go"
)

// How far a copy, zip or unzip has gone, for the Activity panel's percent:
// the bytes to process are measured first, then counted as the job reads or
// writes them, and published once a second (only when they moved).

type jobProgress struct {
	total int64
	done  atomic.Int64
}

type progressInfo struct {
	Done  int64 `json:"done"`
	Total int64 `json:"total"`
}

type progressKey struct{}

func withProgress(ctx context.Context, p *jobProgress) context.Context {
	return context.WithValue(ctx, progressKey{}, p)
}

// addProgress counts n bytes for the job carried by ctx, if it tracks any.
func addProgress(ctx context.Context, n int64) {
	if p, ok := ctx.Value(progressKey{}).(*jobProgress); ok && n > 0 {
		p.done.Add(n)
	}
}

// treeSize is the size of the regular files under the paths (links are not
// followed: a copy refuses them anyway).
func treeSize(ctx context.Context, paths ...string) int64 {
	var total int64
	for _, root := range paths {
		_ = filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
			if ctx.Err() != nil {
				return ctx.Err() // cancelled while measuring
			}
			if err != nil {
				return nil
			}
			if d.Type().IsRegular() {
				if info, err := d.Info(); err == nil {
					total += info.Size()
				}
			}
			return nil
		})
	}
	return total
}

// zipContentSize is the uncompressed size of an archive's files.
func zipContentSize(path string) int64 {
	r, err := zip.OpenReader(path)
	if err != nil {
		return 0
	}
	defer r.Close()
	var total int64
	for _, f := range r.File {
		if !f.FileInfo().IsDir() {
			total += int64(f.UncompressedSize64)
		}
	}
	return total
}

const progressEvery = time.Second

// reportProgress publishes p for jobID every second until stop is closed.
func reportProgress(nc *nats.Conn, jobID string, p *jobProgress, stop <-chan struct{}) {
	t := time.NewTicker(progressEvery)
	defer t.Stop()
	reportProgressOn(nc, jobID, p, t.C, stop)
}

func reportProgressOn(nc *nats.Conn, jobID string, p *jobProgress, tick <-chan time.Time, stop <-chan struct{}) {
	last := int64(-1)
	for {
		select {
		case <-stop:
			return
		case <-tick:
			done := p.done.Load()
			if done == last {
				continue
			}
			last = done
			data, _ := json.Marshal(jobEvent{JobID: jobID, Status: "progress", Progress: &progressInfo{Done: done, Total: p.total}})
			if err := publishEvent(nc, fmt.Sprintf("events.job.%s", jobID), data); err != nil {
				log.Printf("publish progress for job %s: %v", jobID, err)
			}
		}
	}
}

// trackProgress measures the job's bytes, then reports them until stop runs.
func trackProgress(ctx context.Context, nc *nats.Conn, jobID string, total int64) (context.Context, func()) {
	if total <= 0 {
		return ctx, func() {}
	}
	p := &jobProgress{total: total}
	stop := make(chan struct{})
	go reportProgress(nc, jobID, p, stop)
	return withProgress(ctx, p), func() { close(stop) }
}
