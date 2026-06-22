# Chunked File Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let impersonated users download/preview files of any size over `GET /files/download` without truncation, NATS payload overflow, or backend memory blowup, by replacing the single whole-file `requestRead()` call with a chunked read loop that mirrors the existing chunked-upload pattern.

**Architecture:** Add a new NATS request-reply subject `root.fs.read-chunk` to the Go root-worker that reads at most 4 MB starting at a given byte offset (via `os.File.ReadAt`), add a matching `requestReadChunk()` helper in the backend, and rewrite the impersonated branch of `GET /files/download` to `stat` the file first and then pull it through as a Node `Readable` stream that requests one 4 MB chunk at a time — so bytes reach the HTTP response as they arrive instead of after the whole file has been buffered.

**Tech Stack:** Go (root-worker, NATS request-reply), Fastify + `nats.js` (backend), no test framework in either app — verification is `go build`, `tsc --noEmit`, and a manual pass (this matches how every other fs-worker change in this repo has been verified; there are zero `*_test.go` or `*.test.ts` files in either app today).

## Global Constraints

- Hard per-chunk cap of 4 MB (`maxReadChunkBytes`), enforced server-side in the Go worker regardless of what length the backend requests — copied verbatim from the spec.
- The existing `root.fs.read` subject, `doRead()`, `requestRead()`, and `fs.readText` (3 MB-bounded, already safe) are not modified by this plan.
- The direct (non-impersonated/admin) download branch using `createReadStream` is not touched.
- No new npm or Go dependencies.

---

### Task 1: Go root-worker — `root.fs.read-chunk` subject

**Files:**
- Modify: `apps/root-worker/fs.go` (add `doReadChunk` next to `doRead`, after line 231)
- Modify: `apps/root-worker/main.go` (add `readChunkReq` type + `handleReadChunk` next to `handleRead`, after line 324; register the subject in the handler map at line 552)

**Interfaces:**
- Consumes: `validateScoped(p, root) *fsError` (`fs.go:78`), `withUser(username string, fn func() error) error` (`main.go:104`), `replyErr`/`replyOk` (`main.go:81`/`76`), `mapOsErr(err error) *fsError` (`fs.go:107`).
- Produces: Go worker subscribes to subject `root.fs.read-chunk`. Request body (JSON): `{ path: string, offset: number, length: number, linuxUsername: string, allowedRoot: string }`. Reply: raw bytes (not JSON-wrapped) — same convention as `root.fs.read`. A reply may be shorter than the requested `length` (end-of-file) or empty (offset at/past EOF) — both are valid, non-error replies.

- [ ] **Step 1: Add `doReadChunk` to `fs.go`**

Insert immediately after `doRead` (after line 231, before the `// ── mkdir ──` section header):

```go
const maxReadChunkBytes = 4 * 1024 * 1024 // 4 MB hard cap, independent of caller-requested length

func doReadChunk(path string, offset int64, length int) ([]byte, *fsError) {
	if length <= 0 || length > maxReadChunkBytes {
		length = maxReadChunkBytes
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, mapOsErr(err)
	}
	defer f.Close()
	buf := make([]byte, length)
	n, err := f.ReadAt(buf, offset)
	if err != nil && err != io.EOF {
		return nil, mapOsErr(err)
	}
	return buf[:n], nil
}
```

`io` and `os` are already imported at the top of `fs.go` (used by `doRead`) — no import changes needed.

- [ ] **Step 2: Add `handleReadChunk` to `main.go`**

Insert immediately after `handleRead` (after line 324, before the `// ── JetStream task handler ──` section header):

```go
type readChunkReq struct {
	Path          string `json:"path"`
	Offset        int64  `json:"offset"`
	Length        int    `json:"length"`
	LinuxUsername string `json:"linuxUsername"`
	AllowedRoot   string `json:"allowedRoot"`
}

func handleReadChunk(nc *nats.Conn, msg *nats.Msg) {
	var req readChunkReq
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
		data, fsErr = doReadChunk(req.Path, req.Offset, req.Length)
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
	// Raw bytes, not JSON-wrapped — same convention as handleRead. May be
	// shorter than req.Length (EOF) or empty (offset at/past EOF); neither
	// is an error, the caller's stat-derived end offset is authoritative.
	_ = nc.Publish(msg.Reply, data)
}
```

- [ ] **Step 3: Register the subject**

In `main.go`, in the request-reply subscription map (around line 549-554), add the new subject next to `root.fs.read`:

```go
		for subj, handler := range map[string]func(*nats.Conn, *nats.Msg){
			"root.fs.list":                     handleList,
			"root.fs.stat":                     handleStat,
			"root.fs.read":                     handleRead,
			"root.fs.read-chunk":               handleReadChunk,
			"root.fs.write-chunk":              handleWriteChunk,
			"root.docker.container.inspect":    handleDockerInspect,
		} {
```

This is a plain request-reply subject (like `root.fs.read` and `root.fs.write-chunk`), not a JetStream-persisted job subject — it must NOT be added to `taskSubjects` (`main.go:117-138`) or the backend's `TASK_STREAM.subjects` (`apps/backend/src/nats.ts:14-38`). Those lists are only for jobs that get a durable `Job` DB row via `publishJob()`; `root.fs.read`/`root.fs.write-chunk` already prove plain sync subjects don't belong there.

- [ ] **Step 4: Build and vet**

```bash
cd apps/root-worker && go build ./... && go vet ./...
```

Expected: both exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add apps/root-worker/fs.go apps/root-worker/main.go
git commit -m "feat(root-worker): add chunked read subject for large-file downloads"
```

---

### Task 2: Backend — `requestReadChunk()` helper

**Files:**
- Modify: `apps/backend/src/nats.ts` (add `requestReadChunk` after `requestRead`, after line 143)

**Interfaces:**
- Consumes: module-level `nc: NatsConnection` and `sc: StringCodec` already defined in this file; the `root.fs.read-chunk` subject from Task 1.
- Produces: `requestReadChunk(path: string, offset: number, length: number, linuxUsername: string, allowedRoot: string, timeout?: number): Promise<Buffer>` — exported for use in Task 3.

- [ ] **Step 1: Add `requestReadChunk` to `nats.ts`**

Insert immediately after `requestRead` (after line 143, before the `// Write a chunk directly...` comment):

```ts
// Chunked counterpart to requestRead — fetches at most `length` bytes
// starting at `offset` (the worker caps this at 4 MB server-side
// regardless of what's requested). Binary reply, same as requestRead.
// May return fewer bytes than requested (EOF) or an empty buffer (offset
// at/past EOF) — both are valid; the caller's own end-offset bookkeeping
// decides when to stop asking for more.
export async function requestReadChunk(
  path: string,
  offset: number,
  length: number,
  linuxUsername: string,
  allowedRoot: string,
  timeout = 10_000,
): Promise<Buffer> {
  const msg = await nc.request(
    "root.fs.read-chunk",
    sc.encode(JSON.stringify({ path, offset, length, linuxUsername, allowedRoot })),
    { timeout },
  )
  return Buffer.from(msg.data)
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/backend && node_modules/.bin/tsc --noEmit
```

Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/nats.ts
git commit -m "feat(backend): add requestReadChunk NATS helper"
```

---

### Task 3: Backend — chunked streaming in `GET /files/download`

**Files:**
- Modify: `apps/backend/src/routes/files.ts` (imports at line 7; impersonated branch, lines 162-184)

**Interfaces:**
- Consumes: `requestSync<T>(subject, payload, timeout?)` (`apps/backend/src/nats.ts:112`), `requestReadChunk(...)` (Task 2), the existing `parseRange(rangeHeader, size)` function already defined in this file (`files.ts:20-43`).
- Produces: no new exports — this is the final consumer in the chain.

- [ ] **Step 1: Add imports**

In `apps/backend/src/routes/files.ts`, change line 7 from:

```ts
import { publishJob, requestRead, writeChunk } from "../nats"
```

to:

```ts
import { publishJob, requestRead, requestReadChunk, requestSync, writeChunk } from "../nats"
```

Also add a `Readable` import at the top, next to the existing `node:fs`/`node:fs/promises` imports (after line 3):

```ts
import { Readable } from "node:stream"
```

- [ ] **Step 2: Add a chunked Readable factory**

Add this helper above `fileRoutes` (after the `authFromRequest` function, before the `// ── Routes ──` section header, i.e. after line 86):

```ts
// Pulls one 4 MB chunk at a time from the worker via requestReadChunk and
// feeds it to whoever is reading the stream (Fastify, in this route) —
// bytes reach the HTTP response as they arrive instead of only after the
// whole file has been read into memory. Mirrors the existing chunked
// upload path (writeChunk / root.fs.write-chunk) in the opposite direction.
function chunkedReadStream(
  filePath: string,
  linuxUser: string,
  allowedRoot: string,
  start: number,
  end: number,
): Readable {
  const READ_CHUNK = 4 * 1024 * 1024
  let offset = start
  return new Readable({
    async read() {
      if (offset > end) {
        this.push(null)
        return
      }
      try {
        const len = Math.min(READ_CHUNK, end - offset + 1)
        const chunk = await requestReadChunk(filePath, offset, len, linuxUser, allowedRoot)
        if (chunk.length === 0) {
          // EOF reached earlier than the stat-derived `end` (file shrank
          // mid-download) — end the stream early rather than erroring.
          this.push(null)
          return
        }
        offset += chunk.length
        this.push(chunk)
      } catch (err) {
        // Headers are already sent by this point, so the response can't
        // fail with a clean status code — destroying the stream aborts
        // the connection. Same failure mode the direct/createReadStream
        // branch below already has if the file disappears mid-stream.
        this.destroy(err as Error)
      }
    },
  })
}
```

- [ ] **Step 3: Replace the impersonated branch**

In the same file, replace lines 162-184 (the entire `if (linuxUser) { ... }` block, from `if (linuxUser) {` through its closing `}` right before `if (allowedRoot && !(await isWithinRoot...`):

```ts
    if (linuxUser) {
      let fileSize: number
      try {
        const s = await requestSync<{ type: string; size: number | null }>(
          "root.fs.stat",
          { path: filePath, linuxUsername: linuxUser, allowedRoot: allowedRoot ?? "" },
        )
        if (s.type !== "file" || s.size == null) return reply.status(400).send("Not a file")
        fileSize = s.size
      } catch (e: any) {
        if (e?.code === "EACCES") return reply.status(403).send("Permission denied")
        if (e?.code === "ENOENT") return reply.status(404).send("Not found")
        return reply.status(500).send(e?.message ?? "Stat failed")
      }

      const range = parseRange(req.headers.range, fileSize)
      if (range && !range.satisfiable) {
        reply.header("Content-Range", `bytes */${fileSize}`)
        return reply.status(416).send()
      }

      const start = range ? range.start : 0
      const end   = range ? range.end   : fileSize - 1
      if (range) {
        reply.header("Content-Range", `bytes ${start}-${end}/${fileSize}`)
        reply.header("Content-Length", String(end - start + 1))
        reply.status(206)
      } else {
        reply.header("Content-Length", String(fileSize))
      }
      return reply.send(chunkedReadStream(filePath, linuxUser, allowedRoot ?? "", start, end))
    }
```

This keeps every header/status decision identical to before (same `parseRange` call, same 416 handling, same `Content-Range`/`Content-Length`/206 logic) — only the data source changes, from one buffered `requestRead()` call to the chunked `Readable`. `reply.send(stream)` is the same mechanism the direct branch below already uses for `createReadStream`.

- [ ] **Step 4: Typecheck**

```bash
cd apps/backend && node_modules/.bin/tsc --noEmit
```

Expected: exit 0, no output.

- [ ] **Step 5: Manual verification**

This needs a running NATS broker + root-worker + backend, and at least one user with `linuxUsername` set (an "impersonated" user). If that environment isn't available to you, say so explicitly instead of claiming this step passed.

1. Build and start the stack per this repo's normal dev flow (`pnpm dev` from the repo root, or the equivalent already used in this environment).
2. Create or locate a test file larger than the old 64 MB cap (e.g. `dd if=/dev/urandom of=/path/in/an/allowed/place/big.bin bs=1M count=200`, sized to whatever the test environment's disk/Place allows) inside a Place the impersonated test user can read.
3. Compute its checksum: `sha256sum big.bin`.
4. As the impersonated user, hit `/files/download?path=...&token=...` (mint a token the same way the dashboard does, or drive it through the UI's download button) and save the response to disk; compare checksums — they must match exactly (this is the regression check for the old silent 64 MB truncation).
5. While step 4's download is in flight, watch the backend Node process's RSS (`ps -o rss,cmd -p <pid>` or `top`) and confirm it stays flat rather than climbing with the file size.
6. Open a video file (any size) in the in-app preview as the impersonated user and seek to a few different points; confirm each seek issues a `Range` request and only the requested span is fetched (no full-file stall before playback starts).
7. Download a small file (well under 4 MB) as the impersonated user; confirm it still downloads correctly (single-chunk path).
8. Download a file as a non-impersonated admin (no `linuxUsername` set) — confirm this still goes through the untouched `createReadStream` branch and works exactly as before.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/files.ts
git commit -m "feat(backend): stream impersonated downloads in 4MB chunks instead of buffering whole file"
```

---

## Self-Review Notes

- **Spec coverage:** Go worker change (Task 1) ✓, backend Node helper (Task 2) ✓, `GET /files/download` impersonated-branch rewrite including Range/seek support (Task 3) ✓, all edge cases from the spec (mid-stream failure, file shrinking, small files, untouched `readText`/direct branch) covered in Task 3 Steps 2-3 and the manual verification list ✓.
- **Deviation from the spec's literal text, corrected here:** the spec's Go section said to add `root.fs.read-chunk` to `TASK_STREAM.subjects` "since it doesn't need a Job row" — that's backwards. `TASK_STREAM.subjects` (and the worker's mirrored `taskSubjects`) is specifically the list of JetStream-persisted, `Job`-row-backed subjects dispatched via `publishJob()`. Plain request-reply subjects that don't get a Job row — `root.fs.read`, `root.fs.write-chunk` — are correctly absent from both lists today. Task 1 Step 3 reflects the actual codebase pattern instead: register the handler only in the `nc.Subscribe` map, leave both subject-list constants untouched.
- **Type consistency:** `requestReadChunk`'s signature in Task 2 (`path, offset, length, linuxUsername, allowedRoot, timeout?`) matches exactly how it's called in Task 3's `chunkedReadStream`. The `root.fs.stat` result shape used in Task 3 (`{ type: string; size: number | null }`) matches the exact pattern already used by `fs.readText` in `apps/backend/src/trpc/routers/fs.ts:177-180`.
