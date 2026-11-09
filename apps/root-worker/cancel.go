package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"

	nats "github.com/nats-io/nats.go"
)

// Cancelling a file job (copy, move, zip, unzip) from the Activity panel. The
// backend sends root.jobs.cancel; a running job sees its context cancelled and
// removes what it wrote, a job still queued is skipped when its lane reaches it.

const cancelSubject = "root.jobs.cancel"

// How long a cancel for a job not started yet is remembered: a queued job
// starts long before, and the set must not grow forever.
const cancelMemory = 24 * time.Hour

var errCancelled = &fsError{Code: "ECANCELED", Message: "Cancelled"}

type cancelRegistry struct {
	mu      sync.Mutex
	running map[string]context.CancelFunc
	early   map[string]time.Time
}

func newCancelRegistry() *cancelRegistry {
	return &cancelRegistry{running: map[string]context.CancelFunc{}, early: map[string]time.Time{}}
}

var jobCancels = newCancelRegistry()

// begin registers a job about to run. cancelled tells it was cancelled before
// it started; done must always be called once the job ends.
func (r *cancelRegistry) begin(jobID string) (ctx context.Context, done func(), cancelled bool) {
	ctx, cancel := context.WithCancel(context.Background())
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.early[jobID]; ok {
		delete(r.early, jobID)
		cancel()
		return ctx, func() {}, true
	}
	r.running[jobID] = cancel
	return ctx, func() {
		r.mu.Lock()
		delete(r.running, jobID)
		r.mu.Unlock()
		cancel()
	}, false
}

// cancel stops a running job, or remembers the id so it never starts.
func (r *cancelRegistry) cancel(jobID string) (running bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if stop, ok := r.running[jobID]; ok {
		stop()
		return true
	}
	now := time.Now()
	for id, at := range r.early {
		if now.Sub(at) > cancelMemory {
			delete(r.early, id)
		}
	}
	r.early[jobID] = now
	return false
}

// ctxErr maps a cancelled context to the job's "Cancelled" failure.
func ctxErr(ctx context.Context) *fsError {
	if ctx.Err() != nil {
		return errCancelled
	}
	return nil
}

// ctxReader stops a copy once its context is cancelled.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// asFsErr turns a context error from deep inside a copy into errCancelled.
func asFsErr(err error) *fsError {
	if errors.Is(err, context.Canceled) {
		return errCancelled
	}
	return mapOsErr(err)
}

// serveCancel answers root.jobs.cancel {"jobId"}: {"running": bool}.
func serveCancel(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		JobID string `json:"jobId"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil || req.JobID == "" {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "jobId is required"})
		return
	}
	running := jobCancels.cancel(req.JobID)
	logger.Info("job cancel requested", "jobId", req.JobID, "running", running)
	data, _ := json.Marshal(syncResponse{Ok: true, Result: map[string]bool{"running": running}})
	_ = nc.Publish(msg.Reply, data)
}
