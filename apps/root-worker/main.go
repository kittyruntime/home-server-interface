package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	nats "github.com/nats-io/nats.go"
)

var reLinuxUsername = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

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

	// AllowedRoot scopes Path/ParentPath/Src/DestFile/Chunks/StagingDir to a
	// directory (the caller's "Place"). DstAllowedRoot scopes DstDir
	// separately since copy/move can cross two different places. Empty
	// means unrestricted (admin operations).
	AllowedRoot    string   `json:"allowedRoot"`
	DstAllowedRoot string   `json:"dstAllowedRoot"`
	Paths          []string `json:"paths"`
}

// syncMsg is the payload for request-reply operations.
type syncMsg struct {
	LinuxUsername string `json:"linuxUsername"`
	Path          string `json:"path"`
	AllowedRoot   string `json:"allowedRoot"`
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
	subject := fmt.Sprintf("events.job.%s", jobID)
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
	"root.fs.mkdir",
	"root.fs.copy",
	"root.fs.move",
	"root.fs.rename",
	"root.fs.delete",
	"root.fs.assemble",
	"root.fs.chmod",
	"root.fs.chown",
	"root.fs.zip",
	"root.fs.unzip",
	// Container (Docker) operations
	"root.container.create",
	"root.container.recreate",
	"root.container.start",
	"root.container.stop",
	"root.container.restart",
	"root.container.remove",
	"root.network.create",
	"root.network.remove",
	"root.volume.create",
	"root.volume.remove",
}

func ensureStream(js nats.JetStreamContext) error {
	cfg := &nats.StreamConfig{
		Name:      "TASKS",
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
// stale (e.g. "root.fs.*") so that PullSubscribe can recreate it with the
// broader "root.>" filter that covers both FS and Docker subjects.
func ensureConsumer(js nats.JetStreamContext) {
	info, err := js.ConsumerInfo("TASKS", "root-worker")
	if err != nil {
		return // doesn't exist yet — PullSubscribe will create it
	}
	if info.Config.FilterSubject == "root.fs.*" {
		log.Println("Migrating pull consumer filter from root.fs.* to root.>")
		if err := js.DeleteConsumer("TASKS", "root-worker"); err != nil {
			log.Printf("warn: delete old consumer: %v", err)
		}
	}
}

// ── Request-reply handlers ────────────────────────────────────────────────────

// handleWriteChunk writes a single upload chunk directly into
// <destDir>/.uploads-<uploadId>/<chunkIndex>.part as the target user.
// Metadata arrives in the "X-Meta" NATS header; raw binary in msg.Data.
func handleWriteChunk(nc *nats.Conn, msg *nats.Msg) {
	type chunkMeta struct {
		UploadID      string `json:"uploadId"`
		ChunkIndex    int    `json:"chunkIndex"`
		DestDir       string `json:"destDir"`
		LinuxUsername string `json:"linuxUsername"`
		AllowedRoot   string `json:"allowedRoot"`
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
	if fsErr := validateScoped(meta.DestDir, meta.AllowedRoot); fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
		return
	}

	stagingDir := filepath.Join(meta.DestDir, ".uploads-"+meta.UploadID)
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
	if fsErr := validateScoped(req.Path, req.AllowedRoot); fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
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
	if fsErr := validateScoped(req.Path, req.AllowedRoot); fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
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

type diskUsageReq struct {
	Path        string `json:"path"`
	AllowedRoot string `json:"allowedRoot"`
}

func handleDiskUsage(nc *nats.Conn, msg *nats.Msg) {
	var req diskUsageReq
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if fsErr := validateScoped(req.Path, req.AllowedRoot); fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
		return
	}
	result, fsErr := doDiskUsage(req.Path)
	if fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
		return
	}
	replyOk(nc, msg.Reply, result)
}

func handleDisks(nc *nats.Conn, msg *nats.Msg) {
	result, fsErr := doListDisks()
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
	if fsErr := validateScoped(req.Path, req.AllowedRoot); fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
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

type readChunkReq struct {
	Path          string `json:"path"`
	Offset        int64  `json:"offset"`
	Length        int    `json:"length"`
	LinuxUsername string `json:"linuxUsername"`
	AllowedRoot   string `json:"allowedRoot"`
}

// replyChunkErr replies to a root.fs.read-chunk request with an error,
// marked via the X-Chunk-Error header so the backend can tell it apart
// from a raw-bytes success reply (read-chunk's success body is arbitrary
// file content, unlike replyErr's JSON-bodied callers, so the error can't
// be distinguished by content alone).
func replyChunkErr(nc *nats.Conn, replySubject string, e *fsError) {
	data, _ := json.Marshal(syncResponse{Ok: false, Error: e.Message, Code: e.Code})
	h := nats.Header{}
	h.Set("X-Chunk-Error", "1")
	_ = nc.PublishMsg(&nats.Msg{Subject: replySubject, Data: data, Header: h})
}

func handleReadChunk(nc *nats.Conn, msg *nats.Msg) {
	var req readChunkReq
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyChunkErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if fsErr := validateScoped(req.Path, req.AllowedRoot); fsErr != nil {
		replyChunkErr(nc, msg.Reply, fsErr)
		return
	}
	var data []byte
	var fsErr *fsError
	if err := withUser(req.LinuxUsername, func() error {
		data, fsErr = doReadChunk(req.Path, req.Offset, req.Length)
		if fsErr != nil {
			return fsErr
		}
		return nil
	}); err != nil {
		if fe, ok := err.(*fsError); ok {
			replyChunkErr(nc, msg.Reply, fe)
		} else {
			replyChunkErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		}
		return
	}
	if fsErr != nil {
		replyChunkErr(nc, msg.Reply, fsErr)
		return
	}
	// Raw bytes, not JSON-wrapped — same convention as handleRead. May be
	// shorter than req.Length (EOF) or empty (offset at/past EOF); neither
	// is an error, the caller's stat-derived end offset is authoritative.
	_ = nc.Publish(msg.Reply, data)
}

func handleMkdirp(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request: " + err.Error()})
		return
	}
	if req.Path == "" {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "path required"})
		return
	}
	if err := os.MkdirAll(req.Path, 0755); err != nil {
		replyErr(nc, msg.Reply, toFsErr(err))
		return
	}
	replyOk(nc, msg.Reply, map[string]bool{"ok": true})
}

func handleLinuxUserCreate(nc *nats.Conn, msg *nats.Msg) {
	var req struct {
		Username string `json:"username"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "bad request"})
		return
	}
	if !reLinuxUsername.MatchString(req.Username) {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "invalid linux username: must match ^[a-z_][a-z0-9_-]{0,31}$"})
		return
	}
	out, err := exec.Command("useradd", "-M", "-s", "/sbin/nologin", req.Username).CombinedOutput()
	if err != nil {
		if x, ok := err.(*exec.ExitError); ok && x.ExitCode() == 9 {
			// exit 9 = user already exists, treat as success
			replyOk(nc, msg.Reply, map[string]any{"ok": true, "existed": true})
			return
		}
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: strings.TrimSpace(string(out))})
		return
	}
	replyOk(nc, msg.Reply, map[string]any{"ok": true})
}

type searchMsg struct {
	LinuxUsername string `json:"linuxUsername"`
	Path          string `json:"path"`
	AllowedRoot   string `json:"allowedRoot"`
	Query         string `json:"query"`
}

type searchResult struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}

func handleSearch(nc *nats.Conn, msg *nats.Msg) {
	var req searchMsg
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if req.Query == "" {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "query is required"})
		return
	}
	if fsErr := validateScoped(req.Path, req.AllowedRoot); fsErr != nil {
		replyErr(nc, msg.Reply, fsErr)
		return
	}

	queryLower := strings.ToLower(req.Query)
	var results []searchResult
	const maxResults = 500

	walkErr := filepath.Walk(req.Path, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		name := info.Name()
		// skip hidden files/dirs
		if strings.HasPrefix(name, ".") && p != req.Path {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if p == req.Path {
			return nil // skip root itself
		}
		if strings.Contains(strings.ToLower(name), queryLower) {
			results = append(results, searchResult{
				Path:  p,
				Name:  name,
				IsDir: info.IsDir(),
				Size:  info.Size(),
			})
			if len(results) >= maxResults {
				return filepath.SkipAll
			}
		}
		return nil
	})
	if walkErr != nil && walkErr != filepath.SkipAll {
		// non-fatal, return what we have
	}
	if results == nil {
		results = []searchResult{}
	}
	replyOk(nc, msg.Reply, results)
}

// ── JetStream task handler ────────────────────────────────────────────────────

func handleTask(nc *nats.Conn, msg *nats.Msg) {
	// Route container/network/volume subjects to the docker handler.
	subj := msg.Subject
	if strings.HasPrefix(subj, "root.container.") || strings.HasPrefix(subj, "root.network.") || strings.HasPrefix(subj, "root.volume.") {
		handleDockerTask(nc, msg, subj)
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
	case "root.fs.mkdir":
		// Also scope the joined target so a Name containing ".." can't be
		// used to escape AllowedRoot via the parent's own valid prefix.
		fsErr = validatePathsScoped(task.AllowedRoot, task.ParentPath, filepath.Join(task.ParentPath, task.Name))
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

	case "root.fs.copy":
		fsErr = validatePathsScoped(task.AllowedRoot, task.Src)
		if fsErr == nil {
			fsErr = validatePathsScoped(task.DstAllowedRoot, task.DstDir)
		}
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

	case "root.fs.move":
		fsErr = validatePathsScoped(task.AllowedRoot, task.Src)
		if fsErr == nil {
			fsErr = validatePathsScoped(task.DstAllowedRoot, task.DstDir)
		}
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

	case "root.fs.rename":
		fsErr = validatePathsScoped(task.AllowedRoot, task.Path, filepath.Join(filepath.Dir(task.Path), task.NewName))
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

	case "root.fs.delete":
		fsErr = validatePathsScoped(task.AllowedRoot, task.Path)
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

	case "root.fs.assemble":
		// DestFile, chunks and the staging dir all live under the same
		// destination directory, so they share AllowedRoot.
		fsErr = validatePathsScoped(task.AllowedRoot, append([]string{task.DestFile}, task.Chunks...)...)
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
				// Clean up staging dir (owned by the backend user — remove as root).
				if task.StagingDir != "" {
					if verr := validateScoped(task.StagingDir, task.AllowedRoot); verr == nil {
						_ = os.RemoveAll(task.StagingDir)
					}
				}
				result = map[string]bool{"ok": true}
			}
		}

	case "root.fs.chmod":
		// chmod runs as root, no impersonation.
		fsErr = validatePaths(task.Path)
		if fsErr == nil {
			fsErr = doChmod(task.Path, task.Mode)
			result = map[string]bool{"ok": true}
		}

	case "root.fs.chown":
		// chown runs as root, no impersonation.
		fsErr = validatePaths(task.Path)
		if fsErr == nil {
			fsErr = doChown(task.Path, task.Owner, task.Group)
			result = map[string]bool{"ok": true}
		}

	case "root.fs.zip":
		allPaths := append(task.Paths, task.DstDir)
		fsErr = validatePathsScoped(task.AllowedRoot, allPaths...)
		if fsErr == nil {
			err := withUser(task.LinuxUsername, func() error {
				fsErr = doZip(task.Paths, task.DstDir, task.Name)
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

	case "root.fs.unzip":
		fsErr = validatePathsScoped(task.AllowedRoot, task.Src)
		if fsErr == nil {
			fsErr = validatePathsScoped(task.DstAllowedRoot, task.DstDir)
		}
		if fsErr == nil {
			err := withUser(task.LinuxUsername, func() error {
				fsErr = doUnzip(task.Src, task.DstDir)
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
	natsPass := getenv("NATS_PASS", "worker-dev")

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
		"root.fs.list":                     handleList,
		"root.fs.stat":                     handleStat,
		"root.fs.diskusage":                handleDiskUsage,
		"root.fs.read":                     handleRead,
		"root.sys.disks":                   handleDisks,
		"root.sys.blockdevices":            handleBlockDevices,
		"root.sys.format":                  handleDiskFormat,
		"root.sys.mount":                   handleDiskMount,
		"root.sys.umount":                  handleDiskUmount,
		"root.sys.raid.create":             handleRaidCreate,
		"root.sys.raid.stop":               handleRaidStop,
		"root.sys.lvm.info":                handleLvmInfo,
		"root.sys.lvm.pv.create":           handlePvCreate,
		"root.sys.lvm.vg.create":           handleVgCreate,
		"root.sys.lvm.lv.create":           handleLvCreate,
		"root.sys.lvm.lv.remove":           handleLvRemove,
		"root.sys.lvm.vg.remove":           handleVgRemove,
		"root.sys.part.init":               handlePartitionInit,
		"root.sys.part.create":             handlePartitionCreate,
		"root.sys.part.delete":             handlePartitionDelete,
		"root.sys.smart":                   handleSmartInfo,
		"root.fs.read-chunk":               handleReadChunk,
		"root.fs.write-chunk":              handleWriteChunk,
		"root.container.inspect":           handleDockerInspect,
		"root.container.listAll":           handleDockerListAll,
		"root.container.logs":              handleDockerLogs,
		"root.container.logs.stop":         handleDockerLogsStop,
		"root.fs.mkdirp":                   handleMkdirp,
		"root.linux.user.create":           handleLinuxUserCreate,
		"root.fs.search":                   handleSearch,
	} {
		h := handler // capture
		if _, err := nc.Subscribe(subj, func(msg *nats.Msg) { h(nc, msg) }); err != nil {
			log.Fatalf("subscribe %s: %v", subj, err)
		}
	}

	// ── JetStream pull consumer (async jobs) ──────────────────────────────
	sub, err := js.PullSubscribe("root.>", "root-worker",
		nats.BindStream("TASKS"),
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

	log.Println("worker ready")

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("Shutting down")
}
