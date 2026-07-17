// ── Upload state management ───────────────────────────────────────────────────
// Centralise the in-memory map, TTL eviction, and chunk limits so that
// files.ts contains only HTTP handler logic.

export const MAX_CHUNKS      = 131_072               // 256 GB at 2 MB/chunk
export const UPLOAD_TTL_MS   = 24 * 60 * 60 * 1_000 // 24 h (large uploads can take many hours)
const        GC_INTERVAL_MS  = 5 * 60 * 1_000         // run GC every 5 min

export interface UploadState {
  received:    Set<number>
  totalChunks: number
  fileName:    string
  destDir:     string
  stagingDir:  string
  linuxUser:   string   // guaranteed non-null at creation
  allowedRoot: string   // Place root destDir was validated against ("" = admin/unrestricted)
  createdAt:   number
  totalBytes?: number   // from X-Total-Bytes on the first chunk; used for the disk preflight only
}

const uploadState = new Map<string, UploadState>()
let gcStarted = false

export function getUpload(id: string): UploadState | undefined {
  return uploadState.get(id)
}

export function setUpload(id: string, state: UploadState): void {
  uploadState.set(id, state)
}

export function deleteUpload(id: string): void {
  uploadState.delete(id)
}

/**
 * Start a periodic GC that evicts uploads silent for more than UPLOAD_TTL_MS.
 * `onStale` is called for each evicted entry so the caller can schedule
 * worker cleanup and emit logs.  Idempotent — safe to call multiple times.
 */
export function startUploadGc(onStale: (id: string, state: UploadState) => void): void {
  if (gcStarted) return
  gcStarted = true
  const timer = setInterval(() => {
    const cutoff = Date.now() - UPLOAD_TTL_MS
    for (const [id, state] of uploadState.entries()) {
      if (state.createdAt < cutoff) {
        uploadState.delete(id)
        onStale(id, state)
      }
    }
  }, GC_INTERVAL_MS)
  // Don't keep the process alive just for GC.
  timer.unref()
}
