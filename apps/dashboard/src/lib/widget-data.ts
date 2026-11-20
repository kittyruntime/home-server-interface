import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, type Ref, type ShallowRef } from 'vue'

// Data behind dashboard widgets. Two widgets reading the same thing share one
// request: a source is keyed, fetched while at least one widget uses it, on
// its own interval, and paused while the tab is hidden.

type Entry = {
  data: ShallowRef<unknown>
  error: Ref<string | null>
  at: Ref<number>
  loading: Ref<boolean>
  fetcher: () => Promise<unknown>
  interval: number
  users: number
  timer: ReturnType<typeof setInterval> | null
  inflight: Promise<void> | null
}

const entries = new Map<string, Entry>()

/** A clock for "updated 2 minutes ago" and staleness, ticking every 15 s. */
export const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
function startClock() {
  if (clock || typeof window === 'undefined') return
  clock = setInterval(() => { now.value = Date.now() }, 15_000)
}

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string' && e.message) return e.message
  return String(e)
}

function load(e: Entry): Promise<void> {
  if (e.inflight) return e.inflight
  e.loading.value = true
  e.inflight = e.fetcher()
    .then(d => { e.data.value = d; e.error.value = null; e.at.value = Date.now() })
    .catch(err => { e.error.value = errorText(err) })
    .finally(() => { e.loading.value = false; e.inflight = null })
  return e.inflight
}

function start(e: Entry) {
  void load(e)
  e.timer = setInterval(() => { if (typeof document === 'undefined' || !document.hidden) void load(e) }, e.interval)
}

function stop(e: Entry) {
  if (e.timer) clearInterval(e.timer)
  e.timer = null
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    now.value = Date.now()
    for (const e of entries.values()) if (e.users > 0 && Date.now() - e.at.value > e.interval) void load(e)
  })
}

export type Source<T> = {
  data: Readonly<Ref<T | undefined>>
  error: Readonly<Ref<string | null>>
  loading: Readonly<Ref<boolean>>
  at: Readonly<Ref<number>>
  /** No answer for three intervals in a row: what is shown is old. */
  stale: Readonly<Ref<boolean>>
  refresh: () => Promise<void>
}

export function useSource<T>(key: string, fetcher: () => Promise<T>, intervalMs: number): Source<T> {
  startClock()
  let e = entries.get(key)
  if (!e) {
    e = { data: shallowRef(undefined), error: ref(null), at: ref(0), loading: ref(false), fetcher, interval: intervalMs, users: 0, timer: null, inflight: null }
    entries.set(key, e)
  }
  const entry = e
  entry.users++
  if (entry.users === 1) start(entry)
  if (getCurrentScope()) {
    onScopeDispose(() => {
      entry.users--
      if (entry.users === 0) stop(entry)
    })
  }
  return {
    data: entry.data as Ref<T | undefined>,
    error: entry.error,
    loading: entry.loading,
    at: entry.at,
    stale: computed(() => entry.at.value > 0 && now.value - entry.at.value > entry.interval * 3),
    refresh: () => load(entry),
  }
}

/** Forget every source (sign-out, tests). */
export function resetSources(): void {
  for (const e of entries.values()) stop(e)
  entries.clear()
}
