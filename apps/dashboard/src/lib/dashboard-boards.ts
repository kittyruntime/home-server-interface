import { computed, ref, shallowRef } from 'vue'
import { trpc } from './trpc'

// Dashboards: named tabs of widgets, kept on the account (dashboard.boards).
// An account without boards of its own sees the set an admin published, else
// the built-in default; its first change saves a copy of its own.

export type WidgetSize = 's' | 'm' | 'l'
export interface BoardWidget { id: string; type: string; size: WidgetSize; settings?: Record<string, unknown> }
export interface Board { id: string; name: string; widgets: BoardWidget[] }
export type BoardSource = 'own' | 'published' | 'default'

export const SIZES: WidgetSize[] = ['s', 'm', 'l']
export const MAX_BOARDS = 12
export const MAX_WIDGETS = 48

/** Widget types of the former per-browser dashboard, and what replaces them. */
const LEGACY: Record<string, string | null> = {
  cpu: 'cpu', memory: 'memory', network: 'network',
  containers: 'apps', storage: 'volumes', smart: 'disks',
  // Folded into the Monitor app.
  sysinfo: null,
}

/** The widgets of the former dashboard stored in this browser, or null. */
export function migrateLegacy(raw: string | null): BoardWidget[] | null {
  if (!raw) return null
  let list: unknown
  try { list = JSON.parse(raw) } catch { return null }
  if (!Array.isArray(list)) return null
  const out: BoardWidget[] = []
  for (const w of list) {
    if (!w || typeof w !== 'object') continue
    const type = LEGACY[(w as { type?: string }).type ?? '']
    if (!type || out.some(o => o.type === type)) continue
    out.push({ id: newWidgetId(), type, size: (w as { cols?: number }).cols === 2 ? 'm' : 's' })
  }
  return out
}

let seq = 0
export function newWidgetId(): string {
  seq = (seq + 1) % 1000
  return `w${Date.now().toString(36)}${seq.toString(36)}`
}

const ADMIN_DEFAULT: Array<[string, WidgetSize]> = [
  ['alerts', 'm'], ['cpu', 's'], ['memory', 's'],
  ['volumes', 'm'], ['backups', 'm'],
  ['apps', 'm'], ['network', 's'], ['activity', 's'],
]
const USER_DEFAULT: Array<[string, WidgetSize]> = [
  ['places', 'm'], ['activity', 's'], ['shares', 's'],
  ['cpu', 's'], ['memory', 's'], ['network', 's'],
]

/** The built-in board: what an admin needs to watch, or a member's own things. */
export function defaultBoards(isAdmin: boolean, can: (type: string) => boolean, name: string): Board[] {
  const widgets = (isAdmin ? ADMIN_DEFAULT : USER_DEFAULT)
    .filter(([type]) => can(type))
    .map(([type, size]) => ({ id: `default-${type}`, type, size }))
  return [{ id: 'default', name, widgets }]
}

/** The list with the widget at `from` moved to `to`. */
export function moveWidget<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list
  const out = [...list]
  const [item] = out.splice(from, 1)
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item!)
  return out
}

// ── Shared state ──────────────────────────────────────────────────────────────

const boards = shallowRef<Board[]>([])
const source = ref<BoardSource>('default')
const loaded = ref(false)
const loadError = ref<string | null>(null)
const active = ref(0)
const editing = ref(false)
const saving = ref(false)
const saveError = ref<string | null>(null)
let saveTimer: ReturnType<typeof setTimeout> | null = null
let loading: Promise<void> | null = null

const ACTIVE_KEY = 'dashboard-board'
const MIGRATED_KEY = 'dashboard-migrated'

function readActive(): number {
  try { return Number(localStorage.getItem(ACTIVE_KEY) ?? 0) || 0 } catch { return 0 }
}

export function useBoards() {
  async function load(fallback: () => Board[]): Promise<void> {
    if (loading) return loading
    loading = (async () => {
      try {
        const res = await trpc.dashboard.boards.query()
        source.value = res.source
        let list: Board[] = res.boards.map(b => ({ ...b, widgets: b.widgets.map(w => ({ ...w, size: w.size as WidgetSize })) }))
        if (res.source !== 'own') {
          // The former dashboard of this browser becomes the account's own board.
          let legacy: BoardWidget[] | null = null
          try { legacy = localStorage.getItem(MIGRATED_KEY) ? null : migrateLegacy(localStorage.getItem('dashboard')) } catch { legacy = null }
          if (legacy && legacy.length) {
            const base = fallback()[0]!
            list = [{ id: 'migrated', name: base.name, widgets: legacy }]
            try { localStorage.setItem(MIGRATED_KEY, '1') } catch { /* private mode */ }
            boards.value = list
            await persist()
            list = boards.value
          } else if (!list.length) list = fallback()
        }
        boards.value = list
        loadError.value = null
      } catch (e) {
        loadError.value = (e as Error).message
        if (!boards.value.length) boards.value = fallback()
      } finally {
        active.value = Math.min(readActive(), Math.max(0, boards.value.length - 1))
        loaded.value = true
      }
    })()
    try { await loading } finally { loading = null }
  }

  async function persist(): Promise<void> {
    saving.value = true
    try {
      const saved = await trpc.dashboard.save.mutate({
        boards: boards.value.map(b => ({ name: b.name, widgets: b.widgets.map(w => ({ id: w.id, type: w.type, size: w.size, ...(w.settings && { settings: w.settings }) })) })),
      })
      // Ids are the server's: keep the widgets as they are, take the board ids.
      boards.value = boards.value.map((b, i) => ({ ...b, id: saved[i]?.id ?? b.id }))
      source.value = 'own'
      saveError.value = null
    } catch (e) {
      saveError.value = (e as Error).message
    } finally {
      saving.value = false
    }
  }

  function commit(next: Board[]): void {
    boards.value = next
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = null; void persist() }, 600)
  }

  const current = computed(() => boards.value[active.value] ?? boards.value[0] ?? null)

  function updateCurrent(fn: (widgets: BoardWidget[]) => BoardWidget[]): void {
    const i = Math.min(active.value, boards.value.length - 1)
    if (i < 0) return
    commit(boards.value.map((b, k) => k === i ? { ...b, widgets: fn(b.widgets) } : b))
  }

  function select(i: number): void {
    active.value = i
    try { localStorage.setItem(ACTIVE_KEY, String(i)) } catch { /* private mode */ }
  }

  return {
    boards, source, loaded, loadError, active, editing, saving, saveError, current,
    load, select,
    addWidget(type: string, size: WidgetSize) {
      updateCurrent(ws => ws.length >= MAX_WIDGETS ? ws : [...ws, { id: newWidgetId(), type, size }])
    },
    removeWidget(id: string) { updateCurrent(ws => ws.filter(w => w.id !== id)) },
    resizeWidget(id: string, size: WidgetSize) { updateCurrent(ws => ws.map(w => w.id === id ? { ...w, size } : w)) },
    configureWidget(id: string, settings: Record<string, unknown> | undefined) {
      updateCurrent(ws => ws.map(w => w.id === id ? { ...w, settings } : w))
    },
    moveWidget(from: number, to: number) { updateCurrent(ws => moveWidget(ws, from, to)) },
    addBoard(name: string) {
      if (boards.value.length >= MAX_BOARDS) return
      commit([...boards.value, { id: newWidgetId(), name, widgets: [] }])
      select(boards.value.length - 1)
    },
    renameBoard(i: number, name: string) { commit(boards.value.map((b, k) => k === i ? { ...b, name } : b)) },
    removeBoard(i: number) {
      if (boards.value.length <= 1) return
      commit(boards.value.filter((_, k) => k !== i))
      select(Math.max(0, Math.min(active.value, boards.value.length - 1)))
    },
    moveBoard(from: number, to: number) {
      commit(moveWidget(boards.value, from, to))
      select(Math.max(0, Math.min(boards.value.length - 1, to)))
    },
    async reset(fallback: () => Board[]) {
      await trpc.dashboard.reset.mutate()
      boards.value = []
      try { localStorage.setItem(MIGRATED_KEY, '1') } catch { /* private mode */ }
      await load(fallback)
    },
    async publish() {
      await trpc.dashboard.publish.mutate({ boards: boards.value.map(b => ({ name: b.name, widgets: b.widgets })) })
    },
    async unpublish() { await trpc.dashboard.unpublish.mutate() },
  }
}
