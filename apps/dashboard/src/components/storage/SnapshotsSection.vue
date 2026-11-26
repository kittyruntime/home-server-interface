<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref } from 'vue'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import LoadingState from '../ui/LoadingState.vue'
import TermHelp from './TermHelp.vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { useToast } from '../../lib/toast'
import { formatDateTime } from '../../lib/format-date'
import { fmtBytes } from './store'
import { loadZfs, zfs } from './zfs-data'
import { byDataset, snapKind, type Snap } from './snapshot-model'
import SnapshotBrowser from './SnapshotBrowser.vue'

// Snapshots of the ZFS datasets: taken by hand or on a schedule (the hourly
// maintenance timer), browsed to restore a file, rolled back, deleted.
const { t } = useI18n()
const toast = useToast()
type Every = 'hourly' | 'daily' | 'weekly' | 'monthly'
type Rule = { dataset: string; every: Every; keep: number }
const snaps = ref<Snap[]>([])
const rules = ref<Rule[]>([])
const draft = ref<Rule[]>([])
const loading = ref(true)
const browsing = ref<string | null>(null)
const EVERY: Every[] = ['hourly', 'daily', 'weekly', 'monthly']
const KEEP: Record<Every, number> = { hourly: 24, daily: 14, weekly: 8, monthly: 12 }

async function load() {
  try {
    const r = await trpc.storage.zfs.snapshots.query()
    snaps.value = r.snapshots
    rules.value = r.rules
    draft.value = r.rules.map(x => ({ ...x }))
  } catch (e: any) {
    toast.error(e?.message ?? t('ui.storage.Zfs.failed'))
  }
}
onMounted(async () => {
  await Promise.all([loadZfs(), load()])
  loading.value = false
})

const datasets = computed(() => (zfs.value?.datasets ?? []).map(d => d.name).sort())
const groups = computed(() => byDataset(snaps.value, datasets.value))
const open = ref<Record<string, boolean>>({})
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(rules.value))
const invalid = computed(() => {
  const seen = new Set<string>()
  return draft.value.some(r => {
    const k = `${r.dataset}@${r.every}`
    const dup = seen.has(k)
    seen.add(k)
    return dup || !r.dataset || !(r.keep >= 1 && r.keep <= 1000)
  })
})
function addRule() {
  const dataset = datasets.value.find(n => !draft.value.some(r => r.dataset === n)) ?? datasets.value[0] ?? ''
  draft.value.push({ dataset, every: 'daily', keep: KEEP.daily })
}

async function run(op: 'zfs.snapshot.create' | 'zfs.snapshot.destroy' | 'zfs.snapshot.rollback' | 'zfs.snapshot.rules', input: Record<string, unknown>, opts: { title: string; actionLabel: string; danger?: boolean; confirmText?: string; notice?: string }, done: string) {
  try {
    await applyPlanned(op, input, opts)
    toast.success(done)
    await load()
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('ui.storage.Zfs.failed'))
  }
}
const take = (dataset: string) => run('zfs.snapshot.create', { dataset }, { title: t('ui.storage.ZfsSnap.takeTitle', { name: dataset }), actionLabel: t('ui.storage.ZfsSnap.take') }, t('ui.storage.ZfsSnap.taken', { name: dataset }))
const destroy = (s: Snap) => run('zfs.snapshot.destroy', { snapshot: s.name }, { title: t('ui.storage.ZfsSnap.deleteTitle', { name: s.name }), actionLabel: t('ui.storage.ZfsSnap.delete'), danger: true }, t('ui.storage.ZfsSnap.deleted', { name: s.name }))
const rollback = (s: Snap) => run('zfs.snapshot.rollback', { snapshot: s.name }, {
  title: t('ui.storage.ZfsSnap.rollbackTitle', { name: s.dataset, snap: s.short }), actionLabel: t('ui.storage.ZfsSnap.rollback'),
  danger: true, confirmText: s.dataset, notice: t('ui.storage.ZfsSnap.rollbackNotice'),
}, t('ui.storage.ZfsSnap.rolledBack', { name: s.dataset }))
const saveRules = () => run('zfs.snapshot.rules', { rules: draft.value }, { title: t('ui.storage.ZfsSnap.rulesTitle'), actionLabel: t('ui.storage.MaintenanceSection.saveSchedule') }, t('ui.storage.ZfsSnap.rulesSaved'))

const KIND_CLASS: Record<string, string> = { manual: 'bg-base-200 text-base-content', other: 'bg-base-200 text-base-content/70' }
</script>

<template>
  <div>
    <div class="mb-4">
      <h2 class="flex items-center gap-1.5 text-lg font-semibold text-base-content">{{ t('ui.storage.ZfsSnap.heading') }}<TermHelp term="snapshot" /></h2>
      <p class="mt-0.5 text-sm text-base-content/70">{{ t('ui.storage.ZfsSnap.subtitle') }}</p>
    </div>
    <LoadingState v-if="loading" variant="block" />
    <Card v-else-if="!datasets.length" class="block gap-0 py-0 shadow-none px-4 py-8 text-center text-sm text-base-content/70">{{ t('ui.storage.Zfs.noDatasets') }}</Card>
    <template v-else>
      <Card class="mb-4 block gap-0 py-0 shadow-none p-4">
        <h3 class="text-sm font-semibold text-base-content">{{ t('ui.storage.ZfsSnap.rulesHeading') }}</h3>
        <p class="mt-0.5 text-xs text-base-content/70">{{ t('ui.storage.ZfsSnap.rulesHint') }}</p>
        <p v-if="!draft.length" class="mt-3 text-sm text-base-content/70">{{ t('ui.storage.ZfsSnap.noRules') }}</p>
        <div v-for="(r, i) in draft" :key="i" class="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <select v-model="r.dataset" class="select select-sm w-auto min-w-0 font-mono" :aria-label="t('ui.storage.ZfsSnap.dataset')">
            <option v-for="n in datasets" :key="n" :value="n">{{ n }}</option>
            <option v-if="r.dataset && !datasets.includes(r.dataset)" :value="r.dataset">{{ t('ui.storage.ZfsSnap.gone', { name: r.dataset }) }}</option>
          </select>
          <select v-model="r.every" class="select select-sm w-auto" :aria-label="t('ui.storage.ZfsSnap.every')" @change="r.keep = KEEP[r.every]">
            <option v-for="e in EVERY" :key="e" :value="e">{{ t(`ui.storage.ZfsSnap.everyOpt.${e}`) }}</option>
          </select>
          <label class="flex items-center gap-1.5">
            {{ t('ui.storage.ZfsSnap.keep') }}
            <input v-model.number="r.keep" type="number" min="1" max="1000" class="input input-sm w-20 tabular-nums">
          </label>
          <Button variant="ghost" size="xs" @click="draft.splice(i, 1)">{{ t('ui.storage.ZfsSnap.removeRule') }}</Button>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size="xs" @click="addRule">{{ t('ui.storage.ZfsSnap.addRule') }}</Button>
          <Button v-if="dirty" size="xs" :disabled="invalid" @click="saveRules">{{ t('ui.storage.MaintenanceSection.saveSchedule') }}</Button>
        </div>
      </Card>

      <Card v-for="g in groups" :key="g.dataset" class="mb-3 block gap-0 py-0 shadow-none">
        <div class="flex flex-wrap items-center gap-3 p-4">
          <button type="button" class="min-w-0 flex-1 text-left" :aria-expanded="!!open[g.dataset]" @click="open[g.dataset] = !open[g.dataset]">
            <span class="font-mono text-sm font-semibold text-base-content">{{ g.dataset }}</span>
            <span class="ml-2 text-xs text-base-content/70">{{ t('ui.storage.ZfsSnap.count', { n: g.snaps.length }, g.snaps.length) }}<template v-if="g.used"> · {{ t('ui.storage.ZfsSnap.holding', { size: fmtBytes(g.used) }) }}</template></span>
          </button>
          <Button variant="outline" size="xs" @click="take(g.dataset)">{{ t('ui.storage.ZfsSnap.take') }}</Button>
        </div>
        <ul v-if="open[g.dataset] && g.snaps.length" class="border-t border-base-300">
          <li v-for="s in g.snaps" :key="s.name" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
            <span class="min-w-0 flex-1 truncate font-mono" :title="s.short">{{ s.short }}</span>
            <span class="rounded-sm px-1.5 py-0.5 text-2xs font-semibold uppercase" :class="KIND_CLASS[snapKind(s.short)] ?? 'bg-engine-zfs/15 text-base-content'">{{ t(`ui.storage.ZfsSnap.kind.${snapKind(s.short)}`) }}</span>
            <span class="text-xs text-base-content/70">{{ formatDateTime(s.created * 1000) }}</span>
            <span class="w-20 text-right text-xs text-base-content/70 tabular-nums">{{ fmtBytes(s.used) }}</span>
            <span class="flex gap-1">
              <Button variant="ghost" size="xs" @click="browsing = s.name">{{ t('ui.storage.ZfsSnap.browse') }}</Button>
              <Button variant="ghost" size="xs" @click="rollback(s)">{{ t('ui.storage.ZfsSnap.rollback') }}</Button>
              <Button variant="ghost" size="xs" class="text-error" @click="destroy(s)">{{ t('ui.storage.ZfsSnap.delete') }}</Button>
            </span>
          </li>
        </ul>
        <p v-else-if="open[g.dataset]" class="border-t border-base-300 px-4 py-3 text-sm text-base-content/70">{{ t('ui.storage.ZfsSnap.none') }}</p>
      </Card>
    </template>
    <SnapshotBrowser v-if="browsing" :snapshot="browsing" @close="browsing = null" />
  </div>
</template>
