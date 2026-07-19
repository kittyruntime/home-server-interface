import { ref, readonly } from 'vue'
import { randomId } from './uuid'

export type TransferKind = 'upload' | 'copy' | 'move'
export type TransferStatus =
  | 'queued'
  | 'uploading'
  | 'paused'
  | 'error'
  | 'done'
  | 'cancelled'
  | 'running'

export interface Transfer {
  id: string
  kind: TransferKind
  name: string
  destDir: string
  status: TransferStatus
  error?: string
  totalBytes?: number
  sentBytes?: number
  bytesPerSec?: number
  totalChunks?: number
  sentChunks?: number
  // upload-only runtime (not persisted)
  file?: File
  uploadId?: string
  jobId?: string          // copy/move worker job
  interrupted?: boolean   // reload: needs re-select to resume
}

/** Minimal shape persisted to localStorage to survive reloads (resume flow). */
export interface PersistedUpload {
  id: string
  uploadId?: string
  name: string
  destDir: string
  totalBytes?: number
  totalChunks?: number
}

const STORAGE_KEY = 'transfers.uploads'

// Module-level — shared across every component that calls useUploads()
const tasks = ref<Transfer[]>([])
const pausedIds = new Set<string>()
const abortControllers = new Map<string, AbortController>()

// Sliding window for throughput: id → [{t: ms, bytes: cumulative}]
const throughputWindows = new Map<string, Array<{ t: number; bytes: number }>>()

// Retry bridge: the store doesn't know how to actually retry a copy/move/upload
// (that logic lives in the runner/panel), so runners register a handler per kind
// here instead of the store importing the runner (which would create a cycle).
const retryHandlers = new Map<TransferKind, (id: string) => void>()

export function registerRetryHandler(kind: TransferKind, fn: (id: string) => void) {
  retryHandlers.set(kind, fn)
}

// ── localStorage persistence (upload-resume metadata) ──────────────────────────

function readPersisted(): PersistedUpload[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writePersisted(list: PersistedUpload[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    // ignore (quota exceeded, private browsing, etc.) — persistence is best-effort
  }
}

export function persistUpload(t: Transfer) {
  try {
    const list = readPersisted()
    const entry: PersistedUpload = {
      id: t.id,
      uploadId: t.uploadId,
      name: t.name,
      destDir: t.destDir,
      totalBytes: t.totalBytes,
      totalChunks: t.totalChunks,
    }
    const i = list.findIndex(x => x.id === t.id)
    if (i >= 0) list[i] = entry
    else list.push(entry)
    writePersisted(list)
  } catch {
    // never throw
  }
}

export function clearPersisted(id: string) {
  try {
    writePersisted(readPersisted().filter(x => x.id !== id))
  } catch {
    // never throw
  }
}

export function loadPersisted(): PersistedUpload[] {
  try {
    return readPersisted()
  } catch {
    return []
  }
}

export function useUploads() {
  function register(task: Omit<Transfer, 'kind'> & { kind?: TransferKind }) {
    tasks.value.push({ ...task, kind: task.kind ?? 'upload' })
  }

  function setStatus(id: string, status: TransferStatus, error?: string) {
    const t = tasks.value.find(x => x.id === id)
    if (t) { t.status = status; if (error !== undefined) t.error = error }
  }

  /** Attach a freshly re-selected `File` to an `interrupted` transfer (Task 5:
   *  resume-after-reload) and clear the flag now that it's resumable again. */
  function attachFile(id: string, file: File) {
    const t = tasks.value.find(x => x.id === id)
    if (!t) return
    t.file = file
    t.interrupted = false
  }

  function updateProgress(id: string, sentChunks: number, chunkBytes: number) {
    const t = tasks.value.find(x => x.id === id)
    if (!t) return
    t.sentChunks = sentChunks
    t.sentBytes = (t.sentBytes ?? 0) + chunkBytes

    // Sliding 3-second window for throughput
    const now = Date.now()
    let win = throughputWindows.get(id)
    if (!win) { win = []; throughputWindows.set(id, win) }
    win.push({ t: now, bytes: t.sentBytes })
    const cutoff = now - 3_000
    while (win.length > 1 && win[0]!.t < cutoff) win.shift()
    if (win.length >= 2) {
      const first = win[0]!
      const last  = win[win.length - 1]!
      const dt = (last.t - first.t) / 1000
      const db = last.bytes - first.bytes
      if (dt > 0.05) t.bytesPerSec = db / dt
    }
  }

  /** Reset byte/chunk progress to zero — called at the start of each upload run
   *  (incl. resume/retry) so `updateProgress`'s additive `sentBytes` recomputes
   *  from scratch instead of stacking onto a prior run's total. */
  function resetProgress(id: string) {
    const t = tasks.value.find(x => x.id === id)
    if (!t) return
    t.sentChunks = 0
    t.sentBytes = 0
    t.bytesPerSec = 0
    throughputWindows.delete(id)
  }

  function remove(id: string) {
    const i = tasks.value.findIndex(x => x.id === id)
    if (i >= 0) tasks.value.splice(i, 1)
    pausedIds.delete(id)
    abortControllers.delete(id)
    throughputWindows.delete(id)
  }

  function pause(id: string) {
    pausedIds.add(id)
    setStatus(id, 'paused')
  }

  function resume(id: string) {
    pausedIds.delete(id)
    setStatus(id, 'uploading')
  }

  /** Abort the upload. The chunk loop's catch block sets status to 'cancelled'. */
  function cancel(id: string) {
    pausedIds.delete(id)
    abortControllers.get(id)?.abort()
  }

  function isPaused(id: string) { return pausedIds.has(id) }

  function setAbortController(id: string, ac: AbortController) {
    abortControllers.set(id, ac)
  }

  /** Called in the chunk loop's finally block to release internal refs. */
  function cleanup(id: string) {
    pausedIds.delete(id)
    abortControllers.delete(id)
  }

  /** Dispatch a retry to whichever runner registered a handler for this transfer's kind. */
  function retry(id: string) {
    const t = tasks.value.find(x => x.id === id)
    if (!t) return
    const handler = retryHandlers.get(t.kind)
    handler?.(id)
  }

  return {
    tasks: readonly(tasks),
    register,
    setStatus,
    attachFile,
    updateProgress,
    resetProgress,
    remove,
    pause,
    resume,
    cancel,
    isPaused,
    setAbortController,
    cleanup,
    retry,
  }
}

// ── Transfers: copy/move ────────────────────────────────────────────────────
// Copy/move don't go through the chunked upload runner — each item is a
// single tRPC mutate + pollJob call. `trackTransfer` registers the batch as
// one `copy`/`move` transfer in the tray, drives it via `Promise.allSettled`,
// and keeps the original ops around so a retry can genuinely re-issue the
// same copy/move calls (each op is self-contained: it captures its own
// src/dst, so it stays runnable even after the clipboard that spawned it
// has been cleared).

interface TransferSpec {
  kind: 'copy' | 'move'
  name: string
  destDir: string
  ops: Array<() => Promise<unknown>>
}

const transferSpecs = new Map<string, TransferSpec>()

// Module-level store handle — same pattern as `upload-runner.ts`'s `const
// uploads = useUploads()`: the returned functions all close over the shared
// module-level `tasks` ref, so a single instance here is equivalent to
// calling `useUploads()` per-component.
const store = useUploads()

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'object' && reason !== null && 'message' in reason) {
    const m = (reason as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  return String(reason)
}

/** Run (or re-run, for retry) the ops of an already-registered transfer. */
async function runTransfer(id: string): Promise<void> {
  const spec = transferSpecs.get(id)
  if (!spec) return

  store.setStatus(id, 'running')
  store.resetProgress(id)

  let done = 0
  const results = await Promise.allSettled(
    spec.ops.map(op =>
      op().then(
        (r: unknown) => { done++; store.updateProgress(id, done, 0); return r },
        (e: unknown) => { done++; store.updateProgress(id, done, 0); throw e }
      )
    )
  )

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failures.length === 0) {
    store.setStatus(id, 'done')
    setTimeout(() => { store.remove(id); transferSpecs.delete(id) }, 3000)
  } else {
    const message = errorMessage(failures[0]!.reason)
    store.setStatus(id, 'error', `${failures.length} failed: ${message}`)
  }
}

/** Register a copy/move batch as one transfer in the tray and run it. */
export async function trackTransfer(
  kind: 'copy' | 'move',
  name: string,
  destDir: string,
  ops: Array<() => Promise<unknown>>,
): Promise<void> {
  const id = randomId()
  transferSpecs.set(id, { kind, name, destDir, ops })
  store.register({
    id,
    kind,
    name,
    destDir,
    status: 'running',
    totalChunks: ops.length,
    sentChunks: 0,
  })
  await runTransfer(id)
}

registerRetryHandler('copy', id => { void runTransfer(id) })
registerRetryHandler('move', id => { void runTransfer(id) })
