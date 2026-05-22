package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	nats "github.com/nats-io/nats.go"
)

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ── Message envelopes ─────────────────────────────────────────────────────────

// taskMsg is the payload published by the backend for async jobs.
type taskMsg struct {
	JobID         string   `json:"jobId"`
	LinuxUsername string   `json:"linuxUsername"`
	Path          string   `json:"path"`
	ParentPath    string   `json:"parentPath"`
	Name          string   `json:"name"`
	Src           string   `json:"src"`
	DstDir        string   `json:"dstDir"`
	NewName       string   `json:"newName"`
	DestFile      string   `json:"destFile"`
	Chunks        []string `json:"chunks"`
	StagingDir    string   `json:"stagingDir"`
	Mode          string   `json:"mode"`
	Owner         string   `json:"owner"`
	Group         string   `json:"group"`
}

// syncMsg is the payload for request-reply operations.
type syncMsg struct {
	LinuxUsername string `json:"linuxUsername"`
	Path          string `json:"path"`
}

// syncResponse wraps a successful result for request-reply.
type syncResponse struct {
	Ok     bool        `json:"ok"`
	Result interface{} `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
	Code   string      `json:"code,omitempty"`
}

// jobEvent is what the worker publishes back to the backend.
type jobEvent struct {
	JobID  string      `json:"jobId"`
	Status string      `json:"status"` // completed | failed
	Result interface{} `json:"result,omitempty"`
	Error  string      `json:"error,omitempty"`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func replyOk(nc *nats.Conn, replySubject string, result interface{}) {
	data, _ := json.Marshal(syncResponse{Ok: true, Result: result})
	_ = nc.Publish(replySubject, data)
}

func replyErr(nc *nats.Conn, replySubject string, e *fsError) {
	data, _ := json.Marshal(syncResponse{Ok: false, Error: e.Message, Code: e.Code})
	_ = nc.Publish(replySubject, data)
}

func publishJobResult(nc *nats.Conn, jobID, status string, result interface{}, errMsg string) {
	event := jobEvent{JobID: jobID, Status: status, Result: result, Error: errMsg}
	data, _ := json.Marshal(event)
	subject := fmt.Sprintf("brume.events.job.%s", jobID)
	if err := nc.Publish(subject, data); err != nil {
		log.Printf("publish event for job %s: %v", jobID, err)
	}
}

// resolveUserCtx resolves a linuxUsername to a userCtx, or returns the zero
// value (uid=0) if the username is empty, meaning the op runs as root.
func resolveUserCtx(username string) (userCtx, error) {
	if username == "" {
		return userCtx{uid: 0, gid: 0, gids: []int{0}}, nil
	}
	return resolveUser(username)
}

func withUser(username string, fn func() error) error {
	ctx, err := resolveUserCtx(username)
	if err != nil {
		return err
	}
	if ctx.uid == 0 {
		return fn()
	}
	return runAsUser(ctx, fn)
}

// ── JetStream stream setup ────────────────────────────────────────────────────

var taskSubjects = []string{
	// Filesystem operations
	"brume.root.fs.mkdir",
	"brume.root.fs.copy",
	"brume.root.fs.move",
	"brume.root.fs.rename",
	"brume.root.fs.delete",
	"brume.root.fs.assemble",
	"brume.root.fs.chmod",
	"brume.root.fs.chown",
	// Container (Docker) operations
	"brume.root.docker.container.create",
	"brume.root.docker.container.recreate",
	"brume.root.docker.container.start",
	"brume.root.docker.container.stop",
	"brume.root.docker.container.restart",
	"brume.root.docker.container.remove",
	"brume.root.docker.network.create",
	"brume.root.docker.network.remove",
	"brume.root.docker.volume.create",
	"brume.root.docker.volume.remove",
}

func ensureStream(js nats.JetStreamContext) error {
	cfg := &nats.StreamConfig{
		Name:      "BRUME_TASKS",
		Subjects:  taskSubjects,
		Retention: nats.WorkQueuePolicy,
	}
	_, err := js.AddStream(cfg)
	if err != nil && err.Error() != "nats: stream name already in use" {
		// Try updating in case config changed
		if _, uerr := js.UpdateStream(cfg); uerr != nil {
			return fmt.Errorf("ensure stream: %w", err)
		}
	}
	return nil
}

// ensureConsumer deletes the durable pull consumer if its filter subject is
// stale (e.g. "brume.root.fs.*") so that PullSubscribe can recreate it with the
// broader "brume.root.>" filter that covers both FS and Docker subjects.
func ensureConsumer(js nats.JetStreamContext) {
	info, err := js.ConsumerInfo("BRUME_TASKS", "brume-root-worker")
	if err != nil {
		return // doesn't exist yet — PullSubscribe will create it
	}
	if info.Config.FilterSubject == "brume.root.fs.*" {
		log.Println("Migrating pull consumer filter from brume.root.fs.* to brume.root.>")
		if err := js.DeleteConsumer("BRUME_TASKS", "brume-root-worker"); err != nil {
			log.Printf("warn: delete old consumer: %v", err)
		}
	}
}

// ── Request-reply handlers ────────────────────────────────────────────────────

// handleWriteChunk writes a single upload chunk directly into
// <destDir>/.brume-uploads-<uploadId>/<chunkIndex>.part as the target user.
// Metadata arrives in the "X-Meta" NATS header; raw binary in msg.Data.
func handleWriteChunk(nc *nats.Conn, msg *nats.Msg) {
	type chunkMeta struct {
		UploadID      string `json:"uploadId"`
		ChunkIndex    int    `json:"chunkIndex"`
		DestDir       string `json:"destDir"`
		LinuxUsername string `json:"linuxUsername"`
	}

	metaJSON := msg.Header.Get("X-Meta")
	if metaJSON == "" {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "missing X-Meta header"})
		return
	}
	var meta chunkMeta
	if err := json.Unmarshal([]byte(metaJSON), &meta); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad X-Meta: " + err.Error()})
		return
	}
	if err := validatePath(meta.DestDir); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}

	stagingDir := filepath.Join(meta.DestDir, ".brume-uploads-"+meta.UploadID)
	chunkPath  := filepath.Join(stagingDir, fmt.Sprintf("%d.part", meta.ChunkIndex))
	data       := msg.Data

	var fsErr *fsError
	if err := withUser(meta.LinuxUsername, func() error {
		if err := os.MkdirAll(stagingDir, 0755); err != nil {
			return err
		}
		if err := os.WriteFile(chunkPath, data, 0644); err != nil {
			return err
		}
		return nil
	}); err != nil {
		fsErr = toFsErr(err)
	}

	if fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
		return
	}
	replyOk(nc, msg.Reply, map[string]bool{"ok": true})
}

func handleList(nc *nats.Conn, msg *nats.Msg) {
	var req syncMsg
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if err := validatePath(req.Path); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	var entries []listEntry
	var fsErr *fsError
	if err := withUser(req.LinuxUsername, func() error {
		entries, fsErr = doList(req.Path)
		if fsErr != nil {
			return fsErr
		}
		return nil
	}); err != nil {
		if fe, ok := err.(*fsError); ok {
			replyErr(nc, msg.Reply, fe)
		} else {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		}
		return
	}
	if fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
		return
	}
	replyOk(nc, msg.Reply, entries)
}

func handleStat(nc *nats.Conn, msg *nats.Msg) {
	var req syncMsg
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if err := validatePath(req.Path); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	var result *statResult
	var fsErr *fsError
	if err := withUser(req.LinuxUsername, func() error {
		result, fsErr = doStat(req.Path)
		if fsErr != nil {
			return fsErr
		}
		return nil
	}); err != nil {
		if fe, ok := err.(*fsError); ok {
			replyErr(nc, msg.Reply, fe)
		} else {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		}
		return
	}
	if fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
		return
	}
	replyOk(nc, msg.Reply, result)
}

func handleRead(nc *nats.Conn, msg *nats.Msg) {
	var req syncMsg
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if err := validatePath(req.Path); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	var data []byte
	var fsErr *fsError
	if err := withUser(req.LinuxUsername, func() error {
		data, fsErr = doRead(req.Path)
		if fsErr != nil {
			return fsErr
		}
		return nil
	}); err != nil {
		if fe, ok := err.(*fsError); ok {
			replyErr(nc, msg.Reply, fe)
		} else {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		}
		return
	}
	if fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
		return
	}
	// For binary reads, we reply with raw bytes directly (not JSON-wrapped).
	// The backend handles binary replies specially for the download route.
	_ = nc.Publish(msg.Reply, data)
}

// ── JetStream task handler ────────────────────────────────────────────────────

func handleTask(nc *nats.Conn, msg *nats.Msg) {
	// Route docker subjects to the docker handler before parsing the FS taskMsg.
	if strings.HasPrefix(msg.Subject, "brume.root.docker.") {
		handleDockerTask(nc, msg, msg.Subject)
		return
	}

	var task taskMsg
	if err := json.Unmarshal(msg.Data, &task); err != nil {
		log.Printf("malformed task: %v", err)
		_ = msg.Term()
		return
	}

	subject := msg.Subject

	var result interface{}
	var fsErr *fsError

	switch subject {
	case "brume.root.fs.mkdir":
		fsErr = validatePaths(task.ParentPath)
		if fsErr == nil {
			var res *mkdirResult
			err := withUser(task.LinuxUsername, func() error {
				res, fsErr = doMkdir(task.ParentPath, task.Name)
				if fsErr != nil {
					return fsErr
				}
				return nil
			})
			if err != nil {
				fsErr = toFsErr(err)
			}
			result = res
		}

	case "brume.root.fs.copy":
		fsErr = validatePaths(task.Src, task.DstDir)
		if fsErr == nil {
			var res *copyResult
			err := withUser(task.LinuxUsername, func() error {
				res, fsErr = doCopy(task.Src, task.DstDir)
				if fsErr != nil {
					return fsErr
				}
				return nil
			})
			if err != nil {
				fsErr = toFsErr(err)
			}
			result = res
		}

	case "brume.root.fs.move":
		fsErr = validatePaths(task.Src, task.DstDir)
		if fsErr == nil {
			var res *moveResult
			err := withUser(task.LinuxUsername, func() error {
				res, fsErr = doMove(task.Src, task.DstDir)
				if fsErr != nil {
					return fsErr
				}
				return nil
			})
			if err != nil {
				fsErr = toFsErr(err)
			}
			result = res
		}

	case "brume.root.fs.rename":
		fsErr = validatePaths(task.Path)
		if fsErr == nil {
			var res *renameResult
			err := withUser(task.LinuxUsername, func() error {
				res, fsErr = doRename(task.Path, task.NewName)
				if fsErr != nil {
					return fsErr
				}
				return nil
			})
			if err != nil {
				fsErr = toFsErr(err)
			}
			result = res
		}

	case "brume.root.fs.delete":
		fsErr = validatePaths(task.Path)
		if fsErr == nil {
			err := withUser(task.LinuxUsername, func() error {
				fsErr = doDelete(task.Path)
				if fsErr != nil {
					return fsErr
				}
				return nil
			})
			if err != nil {
				fsErr = toFsErr(err)
			}
			result = map[string]bool{"ok": true}
		}

	case "brume.root.fs.assemble":
		// Chunks are in /tmp (owned by brume backend user) — readable by root.
		// DestFile is in the user's destination dir — write as linuxUser.
		fsErr = validatePaths(append([]string{task.DestFile}, task.Chunks...)...)
		if fsErr == nil {
			err := withUser(task.LinuxUsername, func() error {
				fsErr = doAssemble(task.DestFile, task.Chunks)
				if fsErr != nil {
					return fsErr
				}
				return nil
			})
			if err != nil {
				fsErr = toFsErr(err)
			}
			if fsErr == nil {
				// Clean up staging dir (owned by brume user — remove as root).
				if task.StagingDir != "" {
					if verr := validatePath(task.StagingDir); verr == nil {
						_ = os.RemoveAll(task.StagingDir)
					}
				}
				result = map[string]bool{"ok": true}
			}
		}

	case "brume.root.fs.chmod":
		// chmod runs as root, no impersonation.
		fsErr = validatePaths(task.Path)
		if fsErr == nil {
			fsErr = doChmod(task.Path, task.Mode)
			result = map[string]bool{"ok": true}
		}

	case "brume.root.fs.chown":
		// chown runs as root, no impersonation.
		fsErr = validatePaths(task.Path)
		if fsErr == nil {
			fsErr = doChown(task.Path, task.Owner, task.Group)
			result = map[string]bool{"ok": true}
		}

	default:
		log.Printf("unknown subject: %s", subject)
		_ = msg.Term()
		return
	}

	if fsErr != nil {
		_ = msg.Nak()
		publishJobResult(nc, task.JobID, "failed", nil, fsErr.Message)
	} else {
		_ = msg.Ack()
		publishJobResult(nc, task.JobID, "completed", result, "")
	}
}

func validatePaths(paths ...string) *fsError {
	for _, p := range paths {
		if err := validatePath(p); err != nil {
			return &fsError{Code: "ERR", Message: err.Error()}
		}
	}
	return nil
}

func toFsErr(err error) *fsError {
	if fe, ok := err.(*fsError); ok {
		return fe
	}
	return &fsError{Code: "ERR", Message: err.Error()}
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	natsURL  := getenv("NATS_URL", "nats://127.0.0.1:4222")
	natsUser := getenv("NATS_USER", "worker")
	natsPass := getenv("NATS_PASS", "brume-worker-dev")

	nc, err := nats.Connect(natsURL,
		nats.UserInfo(natsUser, natsPass),
		nats.ReconnectWait(5*time.Second),
		nats.MaxReconnects(-1),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			log.Printf("NATS disconnected: %v", err)
		}),
		nats.ReconnectHandler(func(_ *nats.Conn) {
			log.Println("NATS reconnected")
		}),
	)
	if err != nil {
		log.Fatalf("NATS connect: %v", err)
	}
	defer nc.Drain()
	log.Printf("Connected to NATS at %s", natsURL)

	js, err := nc.JetStream()
	if err != nil {
		log.Fatalf("JetStream: %v", err)
	}

	if err := ensureStream(js); err != nil {
		log.Fatalf("Stream setup: %v", err)
	}

	ensureConsumer(js)

	// ── Request-reply subscriptions (sync ops) ─────────────────────────────
	for subj, handler := range map[string]func(*nats.Conn, *nats.Msg){
		"brume.root.fs.list":                     handleList,
		"brume.root.fs.stat":                     handleStat,
		"brume.root.fs.read":                     handleRead,
		"brume.root.fs.write-chunk":              handleWriteChunk,
		"brume.root.docker.container.inspect":    handleDockerInspect,
	} {
		h := handler // capture
		if _, err := nc.Subscribe(subj, func(msg *nats.Msg) { h(nc, msg) }); err != nil {
			log.Fatalf("subscribe %s: %v", subj, err)
		}
	}

	// ── JetStream pull consumer (async jobs) ──────────────────────────────
	sub, err := js.PullSubscribe("brume.root.>", "brume-root-worker",
		nats.BindStream("BRUME_TASKS"),
		nats.MaxDeliver(3),
		nats.AckExplicit(),
	)
	if err != nil {
		log.Fatalf("pull subscribe: %v", err)
	}

	// Pull loop in background goroutine
	go func() {
		for {
			msgs, err := sub.Fetch(1, nats.MaxWait(5*time.Second))
			if err != nil {
				if err == nats.ErrTimeout {
					continue
				}
				if err == nats.ErrConnectionClosed {
					return
				}
				log.Printf("fetch error: %v", err)
				time.Sleep(time.Second)
				continue
			}
			for _, msg := range msgs {
				handleTask(nc, msg)
			}
		}
	}()

	log.Println("brume-root-worker ready")

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("Shutting down")
}
