// Resilient chunked-upload runner.
//
// Replaces the old inline chunk loop that used to live in FileBrowserPanel.vue:
// each chunk now survives transient network blips (retry with backoff) and
// fails fast on errors a retry can't fix (4xx). Uploads also resume correctly
// after an error — the server tracks which chunks it already staged
// (`GET /files/upload/status`), so retrying/resuming just skips them.
//
// Framework-light on purpose: no component imports, just the transfers store
// (`lib/uploads.ts`) and a couple of small helpers (`lib/jobs.ts`, `lib/uuid.ts`,
// `lib/auth.ts`).
import { createSHA256 } from 'hash-wasm'
import { useAuth } from './auth'
import { pollJobResult } from './jobs'
import { randomId } from './uuid'
import { useToast } from './toast'
import {
  useUploads,
  persistUpload,
  clearPersisted,
  loadPersisted,
  registerRetryHandler,
  type Transfer,
} from './uploads'

const BASE_URL   = import.meta.env.VITE_API_URL ? import.meta.env.VITE_API_URL.replace(/\/trpc$/, '') : ''
const CHUNK_SIZE = 2 * 1024 * 1024
const MAX_ATTEMPTS = 5

const { token } = useAuth()
const uploads = useUploads()
const toast = useToast()

interface ChunkResponse { ok: true; done: boolean }

export interface UploadOpts {
  onDone?: () => void
}

function abortError(): DOMException {
  return new DOMException('Cancelled', 'AbortError')
}

/** setTimeout as a promise that rejects immediately if `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return }
    const onAbort = () => { clearTimeout(timer); reject(abortError()) }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function waitWhilePausedOrAborted(id: string, ac: AbortController): Promise<void> {
  if (ac.signal.aborted) throw abortError()
  while (uploads.isPaused(id)) {
    await sleep(200, ac.signal)
  }
}

async function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  const base   = Math.min(16000, 1000 * 2 ** (attempt - 1))
  const jitter = Math.random() * 300
  await sleep(base + jitter, signal)
}

function chunkByteLength(file: File, index: number): number {
  return Math.min(CHUNK_SIZE, file.size - index * CHUNK_SIZE)
}

interface UploadStatus { known: boolean; staged: number[] }

/** GET /files/upload/status — raw server view of what's already staged for `uploadId`. */
async function fetchUploadStatus(uploadId: string): Promise<UploadStatus | null> {
  try {
    const resp = await fetch(`${BASE_URL}/files/upload/status?uploadId=${encodeURIComponent(uploadId)}`, {
      headers: { 'Authorization': `Bearer ${token.value}` },
    })
    if (!resp.ok) return null
    return await resp.json() as UploadStatus
  } catch {
    return null
  }
}

/** Which chunk indices the server already staged (best-effort: empty on any failure). */
async function fetchStagedChunks(uploadId: string): Promise<Set<number>> {
  // Best-effort — if the status check itself fails, just re-send every chunk
  // (the server treats an already-staged chunk as a harmless rewrite).
  const status = await fetchUploadStatus(uploadId)
  return status?.known ? new Set(status.staged) : new Set()
}

// Up to MAX_ATTEMPTS per chunk, backing off between them. Retries on network
// errors and 5xx (transient); fails fast on 4xx (e.g. 401 unauthenticated,
// 413 too large) since retrying can't fix those. Honors pause/abort both
// before the first attempt and between retries.
async function sendChunkWithRetry(
  t: Transfer,
  file: File,
  body: Uint8Array,
  uploadId: string,
  index: number,
  totalChunks: number,
  ac: AbortController,
): Promise<ChunkResponse> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await waitWhilePausedOrAborted(t.id, ac)

    let resp: Response
    try {
      resp = await fetch(`${BASE_URL}/files/upload/chunk`, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Authorization':  `Bearer ${token.value}`,
          'Content-Type':   'application/octet-stream',
          'X-Upload-Id':    uploadId,
          'X-Chunk-Index':  String(index),
          'X-Total-Chunks': String(totalChunks),
          'X-Total-Bytes':  String(file.size),
          'X-File-Name':    encodeURIComponent(file.name),
          'X-Dest-Dir':     encodeURIComponent(t.destDir),
        },
        body: body as BodyInit,
      })
    } catch (e) {
      // Network error (offline, DNS, connection reset, ...) — retryable,
      // unless it's actually our own abort.
      if (ac.signal.aborted) throw abortError()
      if (attempt === MAX_ATTEMPTS) throw e
      await backoff(attempt, ac.signal)
      continue
    }

    if (resp.ok) return await resp.json() as ChunkResponse

    const bodyText = await resp.text()
    if (resp.status < 500) {
      // Client error — won't be fixed by retrying (401 unauthenticated, 413
      // too large, 403 forbidden, ...). Fail fast with the server's message.
      throw new Error(bodyText || `Upload failed (HTTP ${resp.status})`)
    }
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(bodyText || `Upload failed (HTTP ${resp.status})`)
    }
    await backoff(attempt, ac.signal)
  }

  // Unreachable: the loop above always returns or throws before falling out.
  throw new Error('Upload failed: exhausted retries')
}

// Trigger the explicit, retryable assembly of the staged chunks. The server
// verifies the whole-file SHA-256 during assembly, so a `done` here means the
// destination file matches what the client hashed. Returns the assemble jobId.
async function completeUpload(uploadId: string, sha256: string, ac: AbortController): Promise<string> {
  const resp = await fetch(`${BASE_URL}/files/upload/complete`, {
    method: 'POST',
    signal: ac.signal,
    headers: {
      'Authorization': `Bearer ${token.value}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ uploadId, sha256 }),
  })
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '')
    throw new Error(bodyText || `Could not finalize upload (HTTP ${resp.status})`)
  }
  const { jobId } = await resp.json() as { jobId: string }
  return jobId
}

// Map a failed assemble job to a user-facing message. The worker publishes the
// fsError *message* (not its code), so a checksum mismatch surfaces as
// "checksum mismatch — file corrupted in transfer" — a Retry re-hashes,
// re-sends the missing chunks and re-verifies, so it's worth surfacing plainly.
function assembleErrorMessage(error: string | null): string {
  if (error && /checksum/i.test(error)) {
    return 'File corrupted during transfer — please retry'
  }
  return error || 'Failed to assemble the file on the server'
}

async function runUpload(t: Transfer, file: File, opts: UploadOpts): Promise<void> {
  const ac = new AbortController()
  uploads.setAbortController(t.id, ac)

  const uploadId    = t.uploadId ?? t.id
  const totalChunks = t.totalChunks ?? Math.max(1, Math.ceil(file.size / CHUNK_SIZE))

  try {
    // Recompute progress from scratch for this run (resume/retry reuses the same
    // transfer, whose sentBytes still holds the prior run's total — additive
    // updateProgress would otherwise overshoot >100%).
    uploads.resetProgress(t.id)

    const staged = await fetchStagedChunks(uploadId)

    // Pre-staged chunks (from a previous attempt) are skipped, but their
    // bytes still count toward progress so the bar reflects real state.
    let sentChunks   = 0
    let stagedBytes  = 0
    for (const idx of staged) {
      if (idx >= totalChunks) continue
      sentChunks++
      stagedBytes += chunkByteLength(file, idx)
    }
    if (sentChunks > 0) uploads.updateProgress(t.id, sentChunks, stagedBytes)

    // Whole-file SHA-256, computed incrementally as we read each chunk. Every
    // chunk is read and fed to the hasher (even ones the server already staged
    // from a prior attempt) so the digest is correct on resume; only the
    // not-yet-staged chunks are actually uploaded.
    const hasher = await createSHA256()
    for (let i = 0; i < totalChunks; i++) {
      await waitWhilePausedOrAborted(t.id, ac)

      const buf = new Uint8Array(await file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer())
      hasher.update(buf)

      if (staged.has(i)) continue

      await sendChunkWithRetry(t, file, buf, uploadId, i, totalChunks, ac)
      sentChunks++
      uploads.updateProgress(t.id, sentChunks, chunkByteLength(file, i))
    }

    // Explicit, retryable completion: the server assembles the staged chunks
    // and verifies this whole-file digest before accepting the file. A lost
    // response no longer means a false success — completion is idempotent
    // while the upload state + staging survive (bounded by UPLOAD_TTL GC).
    const sha = hasher.digest('hex')
    const jobId = await completeUpload(uploadId, sha, ac)

    // Server-side assembly streams+hashes the whole file, so give the poll a
    // deadline that scales with size (assume a pessimistic ~10 MB/s floor)
    // rather than the 30 s default — otherwise a large file times out into a
    // false "failed" while the assemble is still legitimately running.
    const assembleDeadline = 60_000 + Math.ceil(file.size / (10 * 1024 * 1024)) * 1000
    const res = await pollJobResult(jobId, assembleDeadline)
    if (res.status !== 'completed') {
      throw new Error(assembleErrorMessage(res.error))
    }
    uploads.setStatus(t.id, 'done')
    clearPersisted(t.id)
    opts.onDone?.()
    setTimeout(() => uploads.remove(t.id), 3000)
  } catch (e) {
    const isAbort = e instanceof DOMException && e.name === 'AbortError'
    if (isAbort) {
      uploads.setStatus(t.id, 'cancelled')
      fetch(`${BASE_URL}/files/upload/cancel`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token.value}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId }),
      }).catch(() => {})
      clearPersisted(t.id)
      setTimeout(() => uploads.remove(t.id), 2500)
    } else {
      // Persistent failure — keep the persisted metadata around (not
      // cleared) so resume/retry can pick the upload back up.
      const message = e instanceof Error ? e.message : String(e)
      uploads.setStatus(t.id, 'error', message)
    }
  } finally {
    uploads.cleanup(t.id)
  }
}

/** Mint a new upload, register it in the transfers store, and start sending. */
export function startUpload(file: File, destDir: string, opts: UploadOpts = {}): void {
  const id = randomId()
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE))

  uploads.register({
    id,
    kind: 'upload',
    name: file.name,
    destDir,
    status: 'uploading',
    totalBytes: file.size,
    sentBytes: 0,
    totalChunks,
    sentChunks: 0,
    bytesPerSec: 0,
    file,
    uploadId: id,
  })

  const t = uploads.tasks.value.find(x => x.id === id)
  if (!t) return
  persistUpload(t)
  void runUpload(t, file, opts)
}

/**
 * Re-run an existing (errored) transfer with a file reference — used both by
 * the retry handler below (same-session retry, `file` already on `t`) and by
 * the reload/re-select flow (Task 5: `interrupted` transfer, freshly
 * re-selected `file` from the user).
 */
export function resumeUpload(id: string, file: File, opts: UploadOpts = {}): void {
  const t = uploads.tasks.value.find(x => x.id === id)
  if (!t) return
  uploads.setStatus(id, 'uploading')
  void runUpload(t, file, opts)
}

/**
 * Re-hydrate transfers for uploads that were mid-flight when the page was
 * reloaded (`localStorage`-persisted metadata, no in-memory `Transfer` — the
 * `File` object itself never survives a reload, that's a hard browser
 * limitation, not a bug). For each persisted entry, ask the server what it
 * already has staged:
 *   - unknown upload (staging GC'd, or it actually finished via another tab) →
 *     drop the stale bookmark, nothing to show.
 *   - known and incomplete → register an `interrupted` transfer so the tray
 *     shows "re-select to resume" instead of silently losing the progress.
 *   - known and already fully staged (assemble was still pending on reload) →
 *     leave the persisted entry alone; nothing to hydrate as interrupted,
 *     and `runUpload`/`clearPersisted` elsewhere will resolve it normally.
 *
 * Call once on app/panel mount, before the user does anything.
 */
export async function hydrateInterruptedUploads(): Promise<void> {
  for (const p of loadPersisted()) {
    const uploadId = p.uploadId ?? p.id
    const status = await fetchUploadStatus(uploadId)

    if (!status) continue // network hiccup — leave the bookmark, retry next reload

    if (!status.known) {
      clearPersisted(p.id)
      continue
    }

    const totalChunks = p.totalChunks ?? 0
    if (totalChunks > 0 && status.staged.length >= totalChunks) continue

    if (uploads.tasks.value.some(x => x.id === p.id)) continue // already registered

    const sentChunks = status.staged.length
    // Exact staged byte count needs the File (last chunk may be short); this
    // is a display-only approximation until the user re-selects and resumes.
    const sentBytes = p.totalBytes !== undefined
      ? Math.min(p.totalBytes, sentChunks * CHUNK_SIZE)
      : undefined

    uploads.register({
      id: p.id,
      kind: 'upload',
      name: p.name,
      destDir: p.destDir,
      status: 'error',
      interrupted: true,
      uploadId,
      totalBytes: p.totalBytes,
      totalChunks: p.totalChunks,
      sentChunks,
      sentBytes,
      error: 'Interrupted — re-select the file to resume',
    })
  }
}

/**
 * Resume an `interrupted` transfer (post-reload) once the user has
 * re-selected a file. The browser gives us no way to reconnect to the
 * original `File` handle across a reload (no File System Access API in use
 * here), so this is the only possible resume path: validate the re-selected
 * file is (almost certainly) the same one — matching name + exact byte size —
 * then attach it and let `runUpload`'s existing staged-chunk skip do the rest.
 *
 * A mismatch never attaches the file and never flips off `interrupted`: the
 * transfer stays exactly as it was, so a wrong pick can't corrupt the resume
 * (worst case the user just has to try again with the right file).
 */
export function resumeByReselect(id: string, file: File): void {
  const t = uploads.tasks.value.find(x => x.id === id)
  if (!t) return

  if (file.name !== t.name || file.size !== t.totalBytes) {
    toast.error('Different file — please select the same file')
    uploads.setStatus(id, 'error', 'Different file — please select the same file')
    return
  }

  uploads.attachFile(id, file)
  resumeUpload(id, file)
}

registerRetryHandler('upload', id => {
  const t = uploads.tasks.value.find(x => x.id === id)
  if (t?.file) {
    resumeUpload(id, t.file)
  }
  // else: the transfer lost its File reference (page reload) — it's marked
  // `interrupted`, and the tray never routes this case through `uploads.retry()`
  // in the first place (see TransfersTray.vue: interrupted rows open a hidden
  // file input directly instead of calling retry). This branch is therefore a
  // documented no-op/safety net — the real resume path is `resumeByReselect`
  // above, invoked once the tray has a freshly re-selected `File`.
})
