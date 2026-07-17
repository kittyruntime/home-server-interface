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
import { useAuth } from './auth'
import { pollJob } from './jobs'
import { randomId } from './uuid'
import {
  useUploads,
  persistUpload,
  clearPersisted,
  registerRetryHandler,
  type Transfer,
} from './uploads'

const BASE_URL   = import.meta.env.VITE_API_URL ? import.meta.env.VITE_API_URL.replace(/\/trpc$/, '') : ''
const CHUNK_SIZE = 2 * 1024 * 1024
const MAX_ATTEMPTS = 5

const { token } = useAuth()
const uploads = useUploads()

interface ChunkResponse { ok: true; done: boolean; jobId?: string }

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

/** GET /files/upload/status — which chunk indices the server already staged. */
async function fetchStagedChunks(uploadId: string): Promise<Set<number>> {
  try {
    const resp = await fetch(`${BASE_URL}/files/upload/status?uploadId=${encodeURIComponent(uploadId)}`, {
      headers: { 'Authorization': `Bearer ${token.value}` },
    })
    if (!resp.ok) return new Set()
    const body = await resp.json() as { known: boolean; staged: number[] }
    return body.known ? new Set(body.staged) : new Set()
  } catch {
    // Best-effort — if the status check itself fails, just re-send every
    // chunk (the server treats an already-staged chunk as a harmless rewrite).
    return new Set()
  }
}

// Up to MAX_ATTEMPTS per chunk, backing off between them. Retries on network
// errors and 5xx (transient); fails fast on 4xx (e.g. 401 unauthenticated,
// 413 too large) since retrying can't fix those. Honors pause/abort both
// before the first attempt and between retries.
async function sendChunkWithRetry(
  t: Transfer,
  file: File,
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
          'X-File-Name':    encodeURIComponent(file.name),
          'X-Dest-Dir':     encodeURIComponent(t.destDir),
        },
        body: file.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
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

    let finalJobId: string | undefined
    for (let i = 0; i < totalChunks; i++) {
      if (staged.has(i)) continue

      await waitWhilePausedOrAborted(t.id, ac)
      const result = await sendChunkWithRetry(t, file, uploadId, i, totalChunks, ac)

      sentChunks++
      uploads.updateProgress(t.id, sentChunks, chunkByteLength(file, i))

      // The last chunk's response carries the fs.assemble jobId — wait for
      // it to actually finish writing the destination file before treating
      // the upload as done.
      if (result.done && result.jobId) finalJobId = result.jobId
    }

    if (finalJobId) await pollJob(finalJobId)
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

registerRetryHandler('upload', id => {
  const t = uploads.tasks.value.find(x => x.id === id)
  if (t?.file) {
    resumeUpload(id, t.file)
  }
  // else: the transfer lost its File reference (page reload) — it's marked
  // `interrupted` and needs the user to re-select the file; that re-select
  // flow (Task 5) calls `resumeUpload` directly once it has a `File` again.
})
