// ── Upload state management ───────────────────────────────────────────────────
// Centralise the in-memory map, TTL eviction, and chunk limits so that
// files.ts contains only HTTP handler logic.

export const MAX_CHUNKS      = 131_072               // 256 GB at 2 MB/chunk
export const UPLOAD_TTL_MS   = 24 * 60 * 60 * 1_000 // 24 h (large uploads can take many hours)
const        GC_INTERVAL_MS  = 5 * 60 * 1_000         // run GC every 5 min
const        CANCEL_TOMBSTONE_TTL_MS = 5 * 60 * 1_000

export interface UploadState {
  ownerUserId: string
  received:    Set<number>
  totalChunks: number
  fileName:    string
  destDir:     string
  tempPath:    string
  linuxUser:   string   // guaranteed non-null at creation
  allowedRoot: string   // Place root destDir was validated against ("" = admin/unrestricted)
  createdAt:   number
  lastActivityAt: number
  totalBytes:  number   // from X-Total-Bytes on the first chunk (required); bounds the disk preflight and every chunk's offset
  finalizeSha?: string
  finalizeJobId?: string
  finalizePromise?: Promise<string>
  cleanupPromise?: Promise<boolean>
  activeWrites: number
  cancelled: boolean
  writeIdleWaiters: Array<() => void>
}

const uploadState = new Map<string, UploadState>()
const uploadCancellationTombstones = new Map<string, number>()
let gcStarted = false

function cancellationKey(id: string, ownerUserId: string): string {
  return `${ownerUserId}\0${id}`
}

function pruneCancellationTombstones(now = Date.now()): void {
  for (const [key, expiresAt] of uploadCancellationTombstones) {
    if (expiresAt <= now) uploadCancellationTombstones.delete(key)
  }
}

export function getUpload(id: string): UploadState | undefined {
  return uploadState.get(id)
}

export function getUploadForOwner(id: string, ownerUserId: string): UploadState | undefined {
  const state = uploadState.get(id)
  return state?.ownerUserId === ownerUserId ? state : undefined
}

export function setUpload(id: string, state: UploadState): void {
  uploadState.set(id, state)
}

/**
 * Claim an upload id without leaving a check/insert gap. A cancellation
 * tombstone wins over creation, which closes the race where DELETE arrives
 * while the first chunk is still in its asynchronous disk preflight.
 */
export function claimUpload(
  id: string,
  candidate: UploadState,
): { cancelled: true } | { cancelled: false; state: UploadState; created: boolean } {
  if (isUploadCancellationPending(id, candidate.ownerUserId)) return { cancelled: true }
  const existing = uploadState.get(id)
  if (existing) return { cancelled: false, state: existing, created: false }
  uploadState.set(id, candidate)
  return { cancelled: false, state: candidate, created: true }
}

export function deleteUpload(id: string): void {
  uploadState.delete(id)
}

export function markUploadActive(state: UploadState): void {
  state.lastActivityAt = Date.now()
}

export function hasUploadFinalizationStarted(state: UploadState): boolean {
  return !!(state.finalizeSha || state.finalizePromise || state.finalizeJobId)
}

export function beginUploadWrite(state: UploadState): boolean {
  if (state.cancelled || hasUploadFinalizationStarted(state)) return false
  state.activeWrites++
  markUploadActive(state)
  return true
}

export function endUploadWrite(state: UploadState): void {
  state.activeWrites = Math.max(0, state.activeWrites - 1)
  if (state.activeWrites === 0) {
    for (const resolve of state.writeIdleWaiters.splice(0)) resolve()
  }
}

export async function waitForUploadWrites(state: UploadState): Promise<void> {
  if (state.activeWrites === 0) return
  await new Promise<void>(resolve => state.writeIdleWaiters.push(resolve))
}

export function cancelUpload(state: UploadState): void {
  state.cancelled = true
  markUploadActive(state)
}

export function deleteUploadIfSame(id: string, state: UploadState): void {
  if (uploadState.get(id) === state) uploadState.delete(id)
}

export function markUploadCancellationPending(id: string, ownerUserId: string): void {
  uploadCancellationTombstones.set(
    cancellationKey(id, ownerUserId),
    Date.now() + CANCEL_TOMBSTONE_TTL_MS,
  )
}

export function isUploadCancellationPending(id: string, ownerUserId: string): boolean {
  const key = cancellationKey(id, ownerUserId)
  const expiresAt = uploadCancellationTombstones.get(key)
  if (expiresAt === undefined) return false
  if (expiresAt <= Date.now()) {
    uploadCancellationTombstones.delete(key)
    return false
  }
  return true
}

export function clearUploadCancellation(id: string, ownerUserId: string): void {
  uploadCancellationTombstones.delete(cancellationKey(id, ownerUserId))
}

/** Resolve the declared size, allowing later chunks to omit the header. */
export function resolveUploadTotalBytes(
  header: string | undefined,
  state?: Pick<UploadState, "totalBytes">,
): number | null {
  if (header === undefined) return state?.totalBytes ?? null
  if (!/^\d+$/.test(header)) return null
  const totalBytes = Number(header)
  return Number.isSafeInteger(totalBytes) ? totalBytes : null
}

export type UploadPhase = "uploading" | "staged" | "finalizing" | "completed" | "failed" | "cancelled"

export function getUploadPhase(state: UploadState, finalizeJobStatus?: string | null): UploadPhase {
  if (state.cancelled) return "cancelled"
  if (finalizeJobStatus === "completed") return "completed"
  if (finalizeJobStatus === "failed") return "failed"
  if (
    state.finalizePromise || state.finalizeSha || state.finalizeJobId ||
    finalizeJobStatus === "pending" || finalizeJobStatus === "running"
  ) return "finalizing"
  return state.received.size === state.totalChunks ? "staged" : "uploading"
}

/**
 * Start a periodic GC that evicts uploads silent for more than UPLOAD_TTL_MS.
 * `onStale` is called for each evicted entry so the caller can schedule
 * worker cleanup and emit logs.  Idempotent: safe to call multiple times.
 */
export function startUploadGc(onStale: (id: string, state: UploadState) => void): void {
  if (gcStarted) return
  gcStarted = true
  const timer = setInterval(() => {
    pruneCancellationTombstones()
    const cutoff = Date.now() - UPLOAD_TTL_MS
    for (const [id, state] of uploadState.entries()) {
      if (state.lastActivityAt < cutoff && state.activeWrites === 0 && !state.finalizePromise) {
        uploadState.delete(id)
        onStale(id, state)
      }
    }
  }, GC_INTERVAL_MS)
  // Don't keep the process alive just for GC.
  timer.unref()
}
