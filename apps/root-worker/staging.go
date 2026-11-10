package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// An upload is staged in <destDir>/.upload-<uploadId>.part until finalize
// renames it. The backend keeps the upload's state in memory only, so a part
// abandoned across a backend restart (every update) was left on disk for good.
// The worker notes each staging file it creates, and sweeps the ones nobody
// wrote to for a day: the backend's own upload lifetime (UPLOAD_TTL_MS).

const (
	uploadPartMaxAge     = 24 * time.Hour
	uploadPartSweepEvery = time.Hour
)

func uploadStagingPath() string {
	return envOr("HSI_UPLOAD_STAGING", "/var/lib/hsi/upload-staging.json")
}

type stagingEntry struct {
	Dir string `json:"dir"`
	ID  string `json:"id"`
}

type stagingRegistry struct {
	mu   sync.Mutex
	path string                // "" reads HSI_UPLOAD_STAGING when used
	seen map[stagingEntry]bool // noted since start: a chunk writes the file once
}

func newStagingRegistry(path string) *stagingRegistry {
	return &stagingRegistry{path: path, seen: map[stagingEntry]bool{}}
}

var uploadStaging = newStagingRegistry("")

func (r *stagingRegistry) file() string {
	if r.path == "" {
		return uploadStagingPath()
	}
	return r.path
}

func stagingFile(e stagingEntry) string {
	return filepath.Join(e.Dir, ".upload-"+e.ID+".part")
}

func (r *stagingRegistry) load() []stagingEntry {
	raw, err := os.ReadFile(r.file())
	if err != nil {
		return nil
	}
	var entries []stagingEntry
	if json.Unmarshal(raw, &entries) != nil {
		return nil
	}
	return entries
}

func (r *stagingRegistry) save(entries []stagingEntry) {
	if err := os.MkdirAll(filepath.Dir(r.file()), 0o700); err != nil {
		logger.Warn("upload staging: cannot create the state folder", "error", err)
		return
	}
	raw, _ := json.Marshal(entries)
	tmp := r.file() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		logger.Warn("upload staging: cannot save", "error", err)
		return
	}
	_ = os.Rename(tmp, r.file())
}

// note records a staging file; only its first chunk writes the registry.
func (r *stagingRegistry) note(dir, id string) {
	e := stagingEntry{Dir: dir, ID: id}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.seen[e] {
		return
	}
	r.seen[e] = true
	entries := r.load()
	for _, x := range entries {
		if x == e {
			return
		}
	}
	r.save(append(entries, e))
}

// sweep removes the staging files untouched for maxAge (the file's own mtime:
// a chunk written an hour ago is an upload in progress) and forgets the ones
// already gone. It returns how many it removed.
func (r *stagingRegistry) sweep(maxAge time.Duration) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	entries := r.load()
	kept := entries[:0]
	removed := 0
	for _, e := range entries {
		info, err := os.Lstat(stagingFile(e))
		if err != nil {
			delete(r.seen, e) // finalized, cancelled or removed by hand
			continue
		}
		if !info.Mode().IsRegular() {
			delete(r.seen, e) // never act through a link or on anything else
			continue
		}
		if time.Since(info.ModTime()) < maxAge {
			kept = append(kept, e)
			continue
		}
		if err := os.Remove(stagingFile(e)); err != nil {
			logger.Warn("upload staging: cannot remove an abandoned part", "path", stagingFile(e), "error", err)
			kept = append(kept, e)
			continue
		}
		delete(r.seen, e)
		removed++
	}
	r.save(kept)
	if removed > 0 {
		logger.Info("upload staging: removed abandoned parts", "count", removed)
	}
	return removed
}

// startStagingSweep sweeps now, then every hour.
func startStagingSweep() {
	go func() {
		uploadStaging.sweep(uploadPartMaxAge)
		t := time.NewTicker(uploadPartSweepEvery)
		defer t.Stop()
		for range t.C {
			uploadStaging.sweep(uploadPartMaxAge)
		}
	}()
}
