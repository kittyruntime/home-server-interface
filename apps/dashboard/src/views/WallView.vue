<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { MonitorOffIcon } from '@lucide/vue'
import WidgetCard from '../components/widgets/WidgetCard.vue'
import StatusBand from '../components/widgets/StatusBand.vue'
import HsiMark from '../components/ui/HsiMark.vue'
import { canUse, widgetDef, type WidgetDef } from '../components/widgets/registry'
import { provideViewer, type Viewer } from '../components/widgets/card-status'
import { trpc, useWallToken } from '../lib/trpc'
import { now } from '../lib/widget-data'
import type { BoardWidget, WidgetSize } from '../lib/dashboard-boards'

// A wall display: one board, full screen, for a tablet or a TV. It signs in
// with the token in the address's fragment (never sent to the server), keeps
// the screen awake while visible and hides the pointer when it rests.

const { t, locale } = useI18n()
const token = decodeURIComponent(location.hash.replace(/^#/, ''))
useWallToken(token.startsWith('hsi_wall_') ? token : null)

const board = ref<{ name: string; widgets: BoardWidget[] } | null>(null)
const viewer = ref<Viewer>({ isAdmin: false, storage: false })
provideViewer(viewer)
const failure = ref<'missing' | 'revoked' | 'offline' | null>(token.startsWith('hsi_wall_') ? null : 'missing')

async function load() {
  if (failure.value === 'missing') return
  try {
    const w = await trpc.dashboard.wall.query()
    board.value = { name: w.name, widgets: w.widgets.map(x => ({ ...x, size: x.size as WidgetSize })) }
    viewer.value = w.viewer
    failure.value = null
  } catch (e) {
    const code = (e as { data?: { code?: string } }).data?.code
    failure.value = code === 'UNAUTHORIZED' || code === 'NOT_FOUND' || code === 'FORBIDDEN' ? 'revoked' : 'offline'
  }
}

const SPAN: Record<WidgetSize, string> = { s: 'col-span-1', m: 'col-span-1 sm:col-span-2', l: 'col-span-1 sm:col-span-2 row-span-2' }
const items = computed(() => (board.value?.widgets ?? []).map(w => ({ w, def: widgetDef(w.type) }))
  .filter((x): x is { w: BoardWidget; def: WidgetDef } => !!x.def && canUse(x.def, viewer.value)))
const clock = computed(() => new Intl.DateTimeFormat(locale.value, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(now.value))

// The screen stays on; the pointer hides after 3 s without moving.
let lock: { release: () => Promise<void> } | null = null
async function keepAwake() {
  try { lock = document.visibilityState === 'visible' ? await (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen') ?? null : null } catch { lock = null }
}
const idle = ref(false)
let idleTimer: ReturnType<typeof setTimeout> | null = null
function moved() {
  idle.value = false
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { idle.value = true }, 3000)
}
let reload: ReturnType<typeof setInterval> | null = null
let tick: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void load()
  void keepAwake()
  document.addEventListener('visibilitychange', keepAwake)
  window.addEventListener('pointermove', moved)
  moved()
  // The board may change on the server: read it again every 5 minutes.
  reload = setInterval(() => { void load() }, 300_000)
  tick = setInterval(() => { now.value = Date.now() }, 30_000)
})
onUnmounted(() => {
  void lock?.release().catch(() => {})
  document.removeEventListener('visibilitychange', keepAwake)
  window.removeEventListener('pointermove', moved)
  if (reload) clearInterval(reload)
  if (tick) clearInterval(tick)
  if (idleTimer) clearTimeout(idleTimer)
  useWallToken(null)
})
</script>

<template>
  <div :class="['min-h-dvh bg-base-200 text-base-content', idle && 'cursor-none']">
    <div v-if="failure && !board" class="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <MonitorOffIcon class="size-10 text-base-content/40" aria-hidden="true" />
      <p class="text-lg font-semibold">{{ t(`widgets.wall.${failure}`) }}</p>
      <p class="max-w-md text-sm text-base-content/70">{{ t(`widgets.wall.${failure}Hint`) }}</p>
    </div>
    <div v-else-if="board" class="flex flex-col gap-4 p-4 sm:p-6">
      <header class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <HsiMark class="size-7" />
        <h1 class="text-lg font-semibold">{{ board.name }}</h1>
        <p class="ml-auto font-figure text-sm tabular-nums text-base-content/70 first-letter:uppercase">{{ clock }}</p>
        <p v-if="failure === 'offline'" class="status-text w-full text-warning"><span class="status-tag">[OLD]</span> {{ t('widgets.wall.offline') }}</p>
      </header>
      <StatusBand v-if="viewer.isAdmin || viewer.storage" :is-admin="viewer.isAdmin" readonly />
      <div class="grid grid-flow-row-dense auto-rows-[minmax(10rem,auto)] grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6">
        <div v-for="{ w, def } in items" :key="w.id" :class="[SPAN[w.size], 'min-w-0']">
          <WidgetCard :widget="w" :def="def" :editing="false" surface="wall" />
        </div>
      </div>
    </div>
  </div>
</template>
