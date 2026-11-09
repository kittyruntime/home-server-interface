import { computed, ref } from 'vue'
import { trpc } from './trpc'
import { useUploads, type Transfer } from './uploads'

// One list for the Activity panel and page: what the NAS runs in the
// background (read from the server, so it survives a closed tab and shows on
// every device) plus the uploads this browser is sending.

export type ServerTask = Awaited<ReturnType<typeof trpc.tasks.list.query>>['running'][number]
export type TaskMeta = ServerTask['meta']

export interface ActivityItem {
  id: string
  kind: ServerTask['kind'] | 'upload'
  status: 'queued' | 'running' | 'paused' | 'error'
  meta: TaskMeta
  owner: ServerTask['owner'] | 'browser'
  startedAt: string | null
  percent: number | null
  remainingSec: number | null
  /** Server task the viewer may cancel (set once cancel exists). */
  cancellable: boolean
  pausable: boolean
  /** Upload cut by a reload: the file must be chosen again to resume. */
  interrupted: boolean
  /** Upload error message. */
  error?: string
}

const FAST_MS = 3_000
const SLOW_MS = 60_000

export function activityPollDelay(s: { running: number; open: boolean }): number {
  return s.running > 0 || s.open ? FAST_MS : SLOW_MS
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`
}

const UPLOAD_STATUS: Partial<Record<Transfer['status'], ActivityItem['status']>> = {
  queued: 'queued',
  uploading: 'running',
  verifying: 'running',
  paused: 'paused',
  error: 'error',
}

function fromUpload(t: Transfer): ActivityItem | null {
  const status = UPLOAD_STATUS[t.status]
  if (!status) return null
  const total = t.totalBytes ?? 0
  const sent = t.sentBytes ?? 0
  const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : null
  const remainingSec = total > 0 && t.bytesPerSec && t.status === 'uploading'
    ? Math.ceil((total - sent) / t.bytesPerSec)
    : null
  return {
    id: t.id,
    kind: 'upload',
    status,
    meta: { kind: 'other', name: t.name, dst: t.destDir },
    owner: 'browser',
    startedAt: null,
    percent,
    remainingSec,
    cancellable: false,
    pausable: !t.interrupted && (t.status === 'uploading' || t.status === 'queued'),
    interrupted: !!t.interrupted,
    error: t.error,
  }
}

function fromServer(v: ServerTask): ActivityItem {
  return {
    id: v.id,
    kind: v.kind,
    status: v.status,
    meta: v.meta,
    owner: v.owner,
    startedAt: v.startedAt,
    percent: v.percent,
    remainingSec: null,
    cancellable: 'cancellable' in v ? Boolean((v as { cancellable?: boolean }).cancellable) : false,
    pausable: false,
    interrupted: false,
  }
}

export function mergeActivity(server: ServerTask[], uploads: Transfer[]): ActivityItem[] {
  const local = uploads.filter(t => t.kind === 'upload')
  const shownHere = new Set(local.flatMap(t => t.finalizeJobIds ?? []))
  const items: ActivityItem[] = []
  for (const t of local) {
    const item = fromUpload(t)
    if (item) items.push(item)
  }
  for (const v of server) {
    if (v.kind === 'finalize' && shownHere.has(v.id)) continue
    items.push(fromServer(v))
  }
  return items
}

// ── Shared poller ────────────────────────────────────────────────────────────

const server = ref<ServerTask[]>([])
const openCount = ref(0)
let started = false
let timer: ReturnType<typeof setTimeout> | null = null

async function refresh(): Promise<void> {
  try {
    server.value = (await trpc.tasks.list.query()).running
  } catch { /* logged out / transient: keep the last list */ }
}

export function useActivity() {
  const { tasks } = useUploads()
  const items = computed(() => mergeActivity(server.value, tasks.value as Transfer[]))
  const running = computed(() => items.value.filter(i => i.status === 'running' || i.status === 'queued').length)
  const uploadPercent = computed<number | null>(() => {
    const ups = (tasks.value as Transfer[]).filter(t => t.kind === 'upload' && (t.status === 'uploading' || t.status === 'verifying' || t.status === 'queued'))
    const total = ups.reduce((n, t) => n + (t.totalBytes ?? 0), 0)
    if (ups.length === 0 || total === 0) return null
    const sent = ups.reduce((n, t) => n + Math.min(t.sentBytes ?? 0, t.totalBytes ?? 0), 0)
    return Math.round((sent / total) * 100)
  })

  function schedule(delay: number) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(tick, delay)
  }
  async function tick() {
    if (typeof document === 'undefined' || !document.hidden) await refresh()
    schedule(activityPollDelay({ running: running.value, open: openCount.value > 0 }))
  }
  if (!started) {
    started = true
    void tick()
  }

  function setOpen(open: boolean) {
    openCount.value = Math.max(0, openCount.value + (open ? 1 : -1))
    // Opening shows the list as it is now, then keeps it fresh.
    if (open) { void refresh(); schedule(FAST_MS) }
  }

  return { items, uploadPercent, setOpen, refresh }
}
