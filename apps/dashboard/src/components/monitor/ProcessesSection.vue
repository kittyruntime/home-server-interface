<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleStopIcon, LockIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import SearchInput from '../ui/SearchInput.vue'
import SortableHeader from '../ui/SortableHeader.vue'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'
import BusyLabel from '../ui/BusyLabel.vue'
import { trpc } from '../../lib/trpc'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import { perf, subscribePerf } from '../../lib/perf-live'
import { fmtRate, heat, matchesProcess, sortProcesses, type ProcessSort } from '../../lib/perf-math'
import { formatBytes } from '../../lib/file-details'

type Row = Awaited<ReturnType<typeof trpc.system.processes.query>>[number]

const { t } = useI18n()
const { confirm } = useConfirm()
const toast = useToast()

const rows = ref<Row[]>([])
const loaded = ref(false)
const error = ref(false)
const query = ref('')
const sortKey = ref<ProcessSort>('cpu')
const sortDir = ref<'asc' | 'desc'>('desc')
const selected = ref<string | null>(null)
const ending = ref(false)
/** Processes already asked to stop: a second request forces them. */
const asked = reactive(new Set<string>())

const keyOf = (r: Row) => `${r.pid}:${r.start}`

async function load() {
  try {
    rows.value = await trpc.system.processes.query()
    error.value = false
  } catch {
    error.value = true
  }
  loaded.value = true
}

let timer: ReturnType<typeof setInterval> | null = null
let stopPerf: (() => void) | null = null
onMounted(() => {
  void load()
  stopPerf = subscribePerf()
  timer = setInterval(() => { if (!document.hidden && !ending.value) void load() }, 3000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  stopPerf?.()
})

function sortBy(key: ProcessSort) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else {
    sortKey.value = key
    sortDir.value = key === 'name' || key === 'user' || key === 'pid' ? 'asc' : 'desc'
  }
}

const shown = computed(() => sortProcesses(rows.value.filter(r => matchesProcess(r, query.value)), sortKey.value, sortDir.value))
const current = computed(() => rows.value.find(r => keyOf(r) === selected.value) ?? null)

const memTotal = computed(() => perf.value?.memory.total ?? 0)
const memPct = (rss: number) => memTotal.value ? (rss / memTotal.value) * 100 : 0
// Disk shade: 100 MB/s fills it.
const diskPct = (bps: number) => Math.min(100, (bps / (100 * 1024 * 1024)) * 100)
const HEAT = ['', 'bg-warning/5', 'bg-warning/12', 'bg-warning/22', 'bg-warning/35'] as const

const totals = computed(() => {
  const p = perf.value
  return {
    cpu: p ? `${Math.round(p.cpu.usage)} %` : '',
    mem: p && p.memory.total ? `${Math.round((p.memory.used / p.memory.total) * 100)} %` : '',
    disk: p ? fmtRate(p.disks.reduce((a, d) => a + d.readBps + d.writeBps, 0)) : '',
  }
})

const columns = computed(() => [
  { key: 'name' as const, label: t('monitor.proc.name'), cls: 'text-left' },
  { key: 'pid' as const, label: 'PID', cls: 'hidden text-right @2xl:table-cell' },
  { key: 'user' as const, label: t('monitor.proc.user'), cls: 'hidden text-left @3xl:table-cell' },
  { key: 'cpu' as const, label: 'CPU', total: totals.value.cpu, cls: 'text-right' },
  { key: 'rss' as const, label: t('monitor.proc.memory'), total: totals.value.mem, cls: 'text-right' },
  { key: 'disk' as const, label: t('monitor.proc.disk'), total: totals.value.disk, cls: 'hidden text-right @xl:table-cell' },
])

function stateLabel(s: string) {
  return ['R', 'S', 'D', 'Z', 'T', 'I'].includes(s) ? t(`monitor.proc.state.${s}`) : s
}

async function end() {
  const r = current.value
  if (!r || r.protected || ending.value) return
  const key = keyOf(r)
  const force = asked.has(key)
  const ok = await confirm(
    force ? t('monitor.proc.forceMessage', { name: r.name }) : t('monitor.proc.endMessage', { name: r.name, pid: r.pid }),
    { title: force ? t('monitor.proc.forceTitle') : t('monitor.proc.endTitle'), confirmLabel: force ? t('monitor.proc.force') : t('monitor.proc.end'), danger: true },
  )
  if (!ok) return
  ending.value = true
  try {
    await trpc.system.processEnd.mutate({ pid: r.pid, start: r.start, name: r.name.slice(0, 64), force })
    asked.add(key)
    toast.success(force ? t('monitor.proc.forced', { name: r.name }) : t('monitor.proc.asked', { name: r.name }))
  } catch (e) {
    const code = (e as { data?: { code?: string } }).data?.code
    toast.error(code === 'NOT_FOUND' ? t('monitor.proc.gone') : code === 'FORBIDDEN' ? t('monitor.proc.protected') : (e as Error).message || t('monitor.proc.failed'))
  } finally {
    ending.value = false
  }
  await load()
}

// Arrow keys move the selection, Delete ends the selected process.
function onKey(e: KeyboardEvent) {
  if (e.key === 'Delete') { e.preventDefault(); void end(); return }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const list = shown.value
  const i = list.findIndex(r => keyOf(r) === selected.value)
  const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
  if (!next) return
  selected.value = keyOf(next)
  document.getElementById(`proc-${next.pid}`)?.scrollIntoView({ block: 'nearest' })
}
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col gap-4">
    <div>
      <h2 class="text-lg font-semibold text-base-content">{{ t('monitor.proc.title') }}</h2>
      <p class="text-sm text-base-content/70">{{ t('monitor.proc.subtitle') }}</p>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <SearchInput v-model="query" :placeholder="t('monitor.proc.search')" class="w-full @md:w-64" />
      <span class="text-xs tabular-nums text-base-content/70">{{ t('monitor.proc.count', { n: shown.length }, shown.length) }}</span>
      <Button variant="outline" size="sm" class="ml-auto" :class="current && !current.protected && 'text-error'"
        :disabled="!current || current.protected || ending" @click="end">
        <BusyLabel :busy="ending"><CircleStopIcon class="size-4" aria-hidden="true" />
          {{ current && asked.has(keyOf(current)) ? t('monitor.proc.force') : t('monitor.proc.end') }}</BusyLabel>
      </Button>
    </div>

    <LoadingState v-if="!loaded" variant="block" />
    <ErrorState v-else-if="error && !rows.length" :message="t('monitor.proc.loadFailed')" :retry-label="t('common.retry')" @retry="load" />

    <Card v-else class="min-h-72 flex-1 gap-0 overflow-hidden py-0">
      <div class="min-h-0 flex-1 overflow-auto" tabindex="-1">
        <table class="w-full text-sm" @keydown="onKey">
          <thead class="sticky top-0 z-10 bg-base-100 shadow-[inset_0_-1px_0_var(--color-base-300)]">
            <tr>
              <th v-for="c in columns" :key="c.key" scope="col" :class="['px-3 py-2 align-bottom text-xs font-medium text-base-content/70', c.cls]"
                :aria-sort="sortKey === c.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined">
                <span v-if="c.total" class="block text-base font-semibold tabular-nums text-base-content">{{ c.total }}</span>
                <SortableHeader :active="sortKey === c.key" :dir="sortDir" @click="sortBy(c.key)">{{ c.label }}</SortableHeader>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in shown" :id="`proc-${r.pid}`" :key="keyOf(r)" tabindex="0" :aria-selected="keyOf(r) === selected"
              class="cursor-default border-b border-base-300/50 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-base-content/30"
              :class="keyOf(r) === selected ? 'bg-primary/20 shadow-[inset_3px_0_0_var(--color-primary)]' : 'hover:bg-base-200/60'"
              @click="selected = keyOf(r)" @keydown.enter.space.prevent="selected = keyOf(r)">
              <td class="max-w-0 px-3 py-1.5">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="truncate text-base-content" :title="r.cmd || r.name">{{ r.name }}</span>
                  <LockIcon v-if="r.protected" class="size-3 shrink-0 text-base-content/50" :aria-label="t('monitor.proc.protectedShort')" />
                  <span v-if="r.state === 'Z' || r.state === 'D' || r.state === 'T'" class="shrink-0 text-2xs text-warning">{{ stateLabel(r.state) }}</span>
                </div>
              </td>
              <td class="hidden px-3 py-1.5 text-right tabular-nums text-base-content/70 @2xl:table-cell">{{ r.pid }}</td>
              <td class="hidden max-w-32 truncate px-3 py-1.5 text-base-content/80 @3xl:table-cell">{{ r.user }}</td>
              <td class="w-20 px-3 py-1.5 text-right tabular-nums" :class="HEAT[heat(r.cpu)]">{{ r.cpu.toFixed(1) }} %</td>
              <td class="w-24 px-3 py-1.5 text-right tabular-nums" :class="HEAT[heat(memPct(r.rss))]">{{ formatBytes(r.rss) }}</td>
              <td class="hidden w-28 px-3 py-1.5 text-right tabular-nums @xl:table-cell" :class="HEAT[heat(diskPct(r.readBps + r.writeBps))]">
                {{ fmtRate(r.readBps + r.writeBps) }}
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!shown.length" class="px-4 py-10 text-center text-sm text-base-content/70">{{ t('monitor.proc.none') }}</p>
      </div>

      <footer v-if="current" class="border-t border-base-300 bg-base-200/40 px-4 py-2.5 text-xs">
        <p class="truncate font-mono text-base-content/90" :title="current.cmd">{{ current.cmd || current.name }}</p>
        <p class="mt-0.5 flex flex-wrap gap-x-4 text-base-content/70">
          <span>PID <span class="tabular-nums text-base-content/90">{{ current.pid }}</span></span>
          <span>{{ t('monitor.proc.parent') }} <span class="tabular-nums text-base-content/90">{{ current.ppid }}</span></span>
          <span>{{ t('monitor.proc.user') }} <span class="text-base-content/90">{{ current.user }}</span></span>
          <span>{{ t('monitor.proc.status') }} <span class="text-base-content/90">{{ stateLabel(current.state) }}</span></span>
          <span>{{ t('monitor.perf.threads') }} <span class="tabular-nums text-base-content/90">{{ current.threads }}</span></span>
          <span v-if="current.protected" class="text-base-content/90">{{ t('monitor.proc.protectedShort') }}</span>
        </p>
      </footer>
    </Card>
  </section>
</template>
