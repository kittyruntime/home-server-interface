<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { DatabaseIcon, EyeIcon } from '@lucide/vue'
import PoolTopology from './PoolTopology.vue'
import TermHelp from './TermHelp.vue'
import { fmtBytes } from './store'
import { layoutOf, scanLine } from './pool-summary'
import { poolUsedPct, type ZfsPool } from './zfs-data'

// One pool: its state, capacity, layout drawn as a tree, and last scrub.
const props = defineProps<{ pool: ZfsPool; watched: boolean; compact?: boolean }>()
const emit = defineEmits<{ open: []; watch: [] }>()
const { t } = useI18n()

const layout = computed(() => layoutOf(props.pool.vdevs))
const scan = computed(() => scanLine(props.pool.scan))
const pct = computed(() => poolUsedPct(props.pool))
const healthy = computed(() => props.pool.state === 'ONLINE')
</script>

<template>
  <Card class="block gap-0 py-0 shadow-none p-4" :class="healthy ? '' : 'border-warning/50'">
    <div class="flex flex-wrap items-center gap-2">
      <DatabaseIcon class="size-4 text-engine-zfs" aria-hidden="true" />
      <Button variant="link" class="h-auto p-0 text-base font-semibold text-base-content" @click="emit('open')">{{ pool.name }}</Button>
      <span class="badge badge-ghost badge-sm">{{ t(`ui.storage.Zfs.layout.${layout.kind}`, layout.kind) }}<template v-if="layout.groups > 1"> × {{ layout.groups }}</template> · {{ t('ui.storage.Zfs.disks', { n: layout.disks }, layout.disks) }}</span>
      <span class="badge badge-sm" :class="healthy ? 'badge-success badge-soft' : 'badge-warning'">{{ t(`ui.storage.Zfs.state.${pool.state}`, pool.state) }}</span>
      <span v-if="watched" class="badge badge-ghost badge-sm gap-1"><EyeIcon class="size-3" aria-hidden="true" />{{ t('ui.storage.Zfs.watched') }}</span>
      <span class="ml-auto text-xs tabular-nums text-base-content/70">{{ t('ui.storage.Zfs.capacity', { used: fmtBytes(pool.alloc), size: fmtBytes(pool.size) }) }}</span>
    </div>
    <Progress class="mt-3 h-1.5 rounded-full bg-base-200" :model-value="pct" :indicator-class="['rounded-full', pct > 90 ? 'bg-warning' : 'bg-engine-zfs']" />
    <div class="mt-4 grid gap-4" :class="compact ? '' : '@2xl/content:grid-cols-2'">
      <PoolTopology :pool="pool" />
      <div class="space-y-1.5 text-xs text-base-content/80">
        <p class="flex items-center gap-1.5">
          <span v-if="scan.kind === 'never'">{{ t('ui.storage.Zfs.noScrub') }}</span>
          <span v-else-if="scan.kind === 'running'">{{ t(`ui.storage.Zfs.running.${scan.what}`, { pct: scan.percent == null ? '?' : Math.round(scan.percent) }) }}</span>
          <span v-else-if="scan.kind === 'canceled'">{{ t(`ui.storage.Zfs.canceled.${scan.what}`, { end: scan.end }) }}</span>
          <span v-else :class="scan.errors ? 'text-warning' : ''">{{ t(`ui.storage.Zfs.done.${scan.what}`, { end: scan.end, n: scan.errors }) }}</span>
          <TermHelp :term="scan.kind !== 'never' && scan.what === 'resilver' ? 'resilver' : 'scrub'" />
        </p>
        <p v-if="pool.frag">{{ t('ui.storage.Zfs.fragmentation', { pct: pool.frag }) }}</p>
        <Button v-if="!watched" variant="outline" size="xs" class="mt-2" @click="emit('watch')">{{ t('ui.storage.Zfs.watch') }}</Button>
      </div>
    </div>
  </Card>
</template>
