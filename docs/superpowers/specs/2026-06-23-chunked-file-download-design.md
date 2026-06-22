# Chunked file download for impersonated users

## Context

`GET /files/download` (`apps/backend/src/routes/files.ts`) serves both forced attachment
downloads and inline media preview (image/video, via `?inline=1`). It branches on whether the
requesting user is "impersonated" (has a `linuxUsername`, the normal case — reads happen as that
Linux user via the privilege-separated Go root-worker) or "direct" (admin with no Linux account
configured — reads happen straight off disk in the Node process).

The direct path already streams correctly: `createReadStream(filePath, { start, end })`, full
Range support, constant memory regardless of file size. The impersonated path does not: it calls
`requestRead()` (`apps/backend/src/nats.ts:131-143`), a single NATS request-reply that returns the
**entire file** as one in-memory `Buffer`, which the route then slices in JS for Range requests.

Three compounding limits make this unsafe for large files:
- The Go worker's `doRead()` (`apps/root-worker/fs.go:218-231`) caps reads at
  `maxReadBytes = 64 * 1024 * 1024` via `io.LimitReader` — files larger than 64MB are **silently
  truncated**, not rejected.
- NATS itself is configured with `max_payload: 67108864` (64MB) — a reply at or near that size
  risks the broker rejecting it outright, which manifests as the request hanging until
  `requestRead()`'s 30s timeout.
- Even within the cap, the whole file (or whole truncated chunk) must arrive over NATS and sit in
  a Node `Buffer` before a single byte reaches the browser — bad for memory and for time-to-first-
  byte on video preview.

There is already a working, symmetric chunked **write** path for uploads (`writeChunk()` in
`nats.ts`, `root.fs.write-chunk` / `handleWriteChunk` in the Go worker, `doAssemble()` streaming
chunk files together via `io.Copy`). This spec adds the missing chunked **read** path, reusing the
same shape.

## Scope

- **In scope**: `GET /files/download`'s impersonated branch (covers both forced download and
  inline media preview, including Range/seek support for video). A new Go worker subject
  `root.fs.read-chunk` and a new Node helper `requestReadChunk()`.
- **Out of scope**: `fs.readText` (`apps/backend/src/trpc/routers/fs.ts:167-213`) — it already
  calls `requestRead()` only after a `stat`-based size check rejects anything over
  `MAX_TEXT_PREVIEW_BYTES` (3MB), well inside every existing cap, so it's already safe and is not
  touched. The existing `root.fs.read` subject, `doRead()`, and `requestRead()` are not modified —
  this adds a sibling primitive rather than changing a working one.

## Go root-worker change

New handler `handleReadChunk` in `apps/root-worker/main.go`, registered on subject
`root.fs.read-chunk`, following the same shape as `handleWriteChunk` (metadata-driven, scoped via
`validateScoped`, executed via `withUser`) and `handleRead` (raw-binary reply convention):

```go
type readChunkReq struct {
	Path          string `json:"path"`
	Offset        int64  `json:"offset"`
	Length        int    `json:"length"`
	LinuxUsername string `json:"linuxUsername"`
	AllowedRoot   string `json:"allowedRoot"`
}

const maxReadChunkBytes = 4 * 1024 * 1024 // 4 MB — server-side hard cap, independent of Length

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
	length := req.Length
	if length <= 0 || length > maxReadChunkBytes {
		length = maxReadChunkBytes
	}

	var data []byte
	if err := withUser(req.LinuxUsername, func() error {
		f, err := os.Open(req.Path)
		if err != nil {
			return err
		}
		defer f.Close()
		buf := make([]byte, length)
		n, err := f.ReadAt(buf, req.Offset)
		if err != nil && err != io.EOF {
			return err
		}
		data = buf[:n]
		return nil
	}); err != nil {
		if fe, ok := err.(*fsError); ok {
			replyErr(nc, msg.Reply, fe)
		} else {
			replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		}
		return
	}
	_ = nc.Publish(msg.Reply, data) // raw bytes, same convention as handleRead
}
```

Register it alongside the other handlers: `"root.fs.read-chunk": handleReadChunk,` next to
`"root.fs.read": handleRead,` in the subject-dispatch map, and add `"root.fs.read-chunk"` to the
`TASK_STREAM.subjects` list in `apps/backend/src/nats.ts` (this is a request-reply subject like
`root.fs.read`/`root.fs.write-chunk`, not a JetStream-persisted job — it doesn't need a `Job` row,
mirroring how plain reads/writes-chunks don't get one either).

`file.ReadAt` returns a short read (or `n=0` with `io.EOF`) at end-of-file — this is not treated
as an error; the backend already knows the file's total size from `stat` and computes exact chunk
boundaries itself, so it never asks for a chunk that would need to signal "no more data" — a short
final chunk is simply the last one.

## Backend (Node) change

New function in `apps/backend/src/nats.ts`, sibling to `requestRead`:

```ts
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

In `apps/backend/src/routes/files.ts`'s `GET /files/download`, the impersonated branch
(`if (linuxUser) { ... }`, currently lines ~162-184) changes from one `requestRead()` call to:

1. `root.fs.stat` (via the existing `requestSync` helper, same call the direct path already makes
   via Node's `stat()`) to get `fileSize`.
2. Reuse the existing `parseRange()` call (already shared by both branches) to compute
   `{ start, end, satisfiable }` against `fileSize` — unchanged logic, just now also driving the
   impersonated branch's loop bounds instead of a post-hoc buffer slice.
3. Set `Content-Length`/`Content-Range`/status (206 or 200) exactly as today.
4. Stream sequentially, writing each chunk to the response as it arrives:

```ts
const READ_CHUNK = 4 * 1024 * 1024
let offset = range?.satisfiable ? range.start : 0
const end   = range?.satisfiable ? range.end : fileSize - 1
while (offset <= end) {
  const len = Math.min(READ_CHUNK, end - offset + 1)
  const chunk = await requestReadChunk(filePath, offset, len, linuxUser, allowedRoot ?? "")
  if (chunk.length === 0) break // EOF reached early (file changed size mid-stream)
  reply.raw.write(chunk)
  offset += chunk.length
}
reply.raw.end()
```

Sequential, one chunk in flight at a time — same as the existing upload path, no parallel
requests, no reordering to handle. Each chunk is written to the HTTP response the moment it
arrives, so the browser starts receiving bytes immediately rather than waiting for the whole file
to be read into memory first.

## Edge cases

- **Mid-stream failure** (file deleted or permission revoked partway through, a chunk's NATS
  request times out): by this point HTTP headers and some body bytes are already sent, so the
  response can't fail with a clean status code. Call `reply.raw.destroy()` to abort the
  connection. This is the same failure mode the direct path already has when a `createReadStream`
  errors mid-flight (e.g. the file is deleted while streaming) — not a new risk, just now reachable
  for impersonated users too.
- **Range requests / video seeking**: the loop starts at `range.start` and stops at `range.end`
  instead of 0/`fileSize - 1`, so seeking only ever transfers the requested span. `416 Range Not
  Satisfiable` handling is unchanged (computed from `fileSize` before the loop starts, same as the
  direct path).
- **File shrinks or is truncated during a long download**: a short or empty chunk returned before
  reaching `end` ends the stream early (`if (chunk.length === 0) break`) rather than erroring —
  best-effort behavior, consistent with how any streaming HTTP server handles a file changing
  underneath it.
- **Small files**: go through the same chunked path now regardless of size (no special-casing by
  size threshold) — at most one chunk for anything under 4MB, functionally identical to before
  except for one extra `stat` round-trip that the direct path already pays today.
- **`fs.readText`**: untouched, as noted in Scope — its own 3MB cap already keeps it well clear of
  every limit this spec addresses.

## Verification

- `cd apps/backend && pnpm exec tsc --noEmit`.
- `cd apps/root-worker && go build ./...`.
- Manual pass (needs a running backend + root-worker + an impersonated test user with a
  `linuxUsername` configured):
  1. Download a file larger than the old 64MB cap end-to-end as an impersonated user; confirm the
     full file arrives intact (checksum match against the source file).
  2. Open a large video file in the in-app preview as an impersonated user and seek around;
     confirm seeking only fetches the requested range (not the whole file) and playback starts
     quickly rather than after a long stall.
  3. While a large download is in progress, watch the backend Node process's memory (`ps`/`top`)
     and confirm it stays flat rather than growing proportionally to the file size.
  4. Confirm small-file downloads (well under 4MB) still work exactly as before.
  5. Confirm a download for a non-impersonated admin (the direct/`createReadStream` path) is
     completely unaffected — this spec doesn't touch that branch.
