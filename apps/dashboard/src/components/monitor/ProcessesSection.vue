<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleStopIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import SearchInput from '../ui/SearchInput.vue'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'
import BusyLabel from '../ui/BusyLabel.vue'
import OwnerRow from './rank/OwnerRow.vue'
import ProcRow from './rank/ProcRow.vue'
import { METRICS, RANK_GRID } from './rank/owners'
import { useOwners } from './rank/use-owners'
import { trpc } from '../../lib/trpc'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import { subscribePerf } from '../../lib/perf-live'
import { loadProcs, procs, procsError, procsLoaded, procsPaused, subscribeProcs, type ProcessRow } from '../../lib/proc-live'
import type { RankMetric } from '../../lib/perf-math'

// Every process, gathered under who it works for (the system, HSI, each app,
// each account) and ranked live. Open an owner to see its processes; pick one
// to read its command or end it.
const props = defineProps<{ focus?: string | null }>()
const { t } = useI18n()
const { confirm } = useConfirm()
const toast = useToast()

const query = ref('')
const metric = ref<RankMetric>('cpu')
const { rows, lit, others } = useOwners(metric, query)
const open = reactive(new Set<string>())
const selected = ref<string | null>(null)
const ending = ref(false)
/** Processes already asked to stop: a second request forces them. */
const asked = reactive(new Set<string>())

const keyOf = (r: ProcessRow) => `${r.pid}:${r.start}`
const searching = computed(() => query.value.trim() !== '')
const isOpen = (key: string) => searching.value || open.has(key)
const toggle = (key: string) => { if (!open.delete(key)) open.add(key) }
const current = computed(() => procs.value.find(r => keyOf(r) === selected.value) ?? null)
const total = computed(() => rows.value.reduce((n, g) => n + g.procs.length, 0))

let stops: Array<() => void> = []
onMounted(async () => {
  stops = [subscribeProcs(), subscribePerf()]
  if (props.focus) {
    open.add(props.focus)
    await nextTick()
    document.getElementById(`owner-${props.focus}`)?.scrollIntoView({ block: 'nearest' })
  }
})
onUnmounted(() => stops.forEach(s => s()))

function stateLabel(s: string) {
  return ['R', 'S', 'D', 'Z', 'T', 'I'].includes(s) ? t(`monitor.proc.state.${s}`) : s
}
const flagOf = (r: ProcessRow) => (r.state === 'Z' || r.state === 'D' || r.state === 'T') ? stateLabel(r.state) : undefined

async function end() {
  const r = current.value
  if (!r || r.protected || ending.value) return
  const key = keyOf(r)
  const force = asked.has(key)
  procsPaused.value = true
  try {
    const ok = await confirm(
      force ? t('monitor.proc.forceMessage', { name: r.name }) : t('monitor.proc.endMessage', { name: r.name, pid: r.pid }),
      { title: force ? t('monitor.proc.forceTitle') : t('monitor.proc.endTitle'), confirmLabel: force ? t('monitor.proc.force') : t('monitor.proc.end'), danger: true },
    )
    if (!ok) return
    ending.value = true
    await trpc.system.processEnd.mutate({ pid: r.pid, start: r.start, name: r.name.slice(0, 64), force })
    asked.add(key)
    toast.success(force ? t('monitor.proc.forced', { name: r.name }) : t('monitor.proc.asked', { name: r.name }))
  } catch (e) {
    const code = (e as { data?: { code?: string } }).data?.code
    toast.error(code === 'NOT_FOUND' ? t('monitor.proc.gone') : code === 'FORBIDDEN' ? t('monitor.proc.protected') : (e as Error).message || t('monitor.proc.failed'))
  } finally {
    ending.value = false
    procsPaused.value = false
  }
  await loadProcs()
}

// Arrow keys move through the open processes, Delete ends the selected one.
function onKey(e: KeyboardEvent) {
  if (e.key === 'Delete') { e.preventDefault(); void end(); return }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const list = rows.value.flatMap(g => isOpen(g.key) ? g.procs.map(p => p.row) : [])
  if (!list.length) return
  e.preventDefault()
  const i = list.findIndex(r => keyOf(r) === selected.value)
  const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]!
  selected.value = keyOf(next)
  const el = document.getElementById(`proc-${keyOf(next)}`)
  el?.focus()
  el?.scrollIntoView({ block: 'nearest' })
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
      <ToggleGroup type="single" variant="tabs" size="sm" :model-value="metric" :aria-label="t('monitor.owners.rankBy')"
        @update:model-value="v => { if (typeof v === 'string' && v) metric = v as RankMetric }">
        <ToggleGroupItem v-for="m in METRICS" :key="m" :value="m">{{ t(`monitor.owners.metric.${m}`) }}</ToggleGroupItem>
      </ToggleGroup>
      <span class="text-xs tabular-nums text-base-content/70">{{ t('monitor.proc.count', { n: total }, total) }}</span>
      <Button variant="outline" size="sm" class="ml-auto" :class="current && !current.protected && 'text-error'"
        :disabled="!current || current.protected || ending" @click="end">
        <BusyLabel :busy="ending"><CircleStopIcon class="size-4" aria-hidden="true" />
          {{ current && asked.has(keyOf(current)) ? t('monitor.proc.force') : t('monitor.proc.end') }}</BusyLabel>
      </Button>
    </div>

    <LoadingState v-if="!procsLoaded" variant="block" />
    <ErrorState v-else-if="procsError && !procs.length" :message="t('monitor.proc.loadFailed')" :retry-label="t('common.retry')" @retry="loadProcs" />

    <Card v-else class="@container min-h-72 flex-1 gap-0 overflow-hidden py-0">
      <div :class="[RANK_GRID, 'border-b border-base-300/70 px-6 py-2 text-2xs font-medium uppercase tracking-caps text-base-content/60']" aria-hidden="true">
        <span>{{ t('monitor.owners.owner') }}</span>
        <span class="text-right">{{ t(`monitor.owners.metric.${metric}`) }}</span>
        <span v-for="m in others" :key="m" class="hidden text-right @xl:block">{{ t(`monitor.owners.metric.${m}`) }}</span>
      </div>

      <div class="min-h-0 flex-1 overflow-auto px-3 py-2" @keydown="onKey">
        <TransitionGroup tag="ol" move-class="transition-transform duration-(--dur-slow) ease-out" :aria-label="t('monitor.owners.title')">
          <li v-for="g in rows" :id="`owner-${g.key}`" :key="g.key" class="scroll-mt-2">
            <OwnerRow :icon="g.icon" :tile="g.tile" :name="g.name" :sub="g.sub" :level="g.level" :value="g.value" :color="g.color" :others="g.others"
              :lit="lit.has(g.key)" :expanded="isOpen(g.key)" @activate="toggle(g.key)" />
            <ol v-if="isOpen(g.key)" class="mb-1.5">
              <li v-for="p in g.procs" :key="keyOf(p.row)">
                <ProcRow :id="`proc-${keyOf(p.row)}`" :name="p.row.name" :title="p.row.cmd || p.row.name"
                  :sub="`PID ${p.row.pid} · ${p.row.user}`" :level="p.level" :value="p.value" :color="g.color" :others="p.others"
                  :selected="keyOf(p.row) === selected" :locked="p.row.protected ? t('monitor.proc.protectedShort') : undefined"
                  :flag="flagOf(p.row)" @select="selected = keyOf(p.row)" />
              </li>
            </ol>
          </li>
        </TransitionGroup>
        <p v-if="!rows.length" class="px-4 py-10 text-center text-sm text-base-content/70">{{ t('monitor.proc.none') }}</p>
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
