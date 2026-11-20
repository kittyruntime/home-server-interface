<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { HardDriveIcon } from '@lucide/vue'
import Empty from '../kit/Empty.vue'
import { DOT, ROWS, TEXT, type Tone } from '../kit/tone'
import { reportSources } from '../card-status'
import { useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import { smartStatus, type SmartResult, type SmartStatus } from '../../storage/smart'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()

// Every disk's SMART summary, without waking a disk in standby.
async function readDisks(): Promise<SmartResult[]> {
  const res = await trpc.storage.blockDevices.query() as { devices: Array<{ name: string; type: string }> }
  const out: SmartResult[] = []
  for (const d of (res.devices ?? []).filter(d => d.type === 'disk')) {
    try { out.push(await trpc.storage.smartInfo.query({ device: d.name, noWake: true }) as SmartResult) }
    catch { out.push({ device: d.name, available: false, rotationRate: 0, healthPassed: false, temperature: 0, powerOnHours: 0, powerCycles: 0, attributes: [] }) }
  }
  return out
}
const src = useSource('disks', readDisks, 300_000)
reportSources(src)

const TONE: Record<SmartStatus, Tone> = { passed: 'ok', warning: 'warn', failed: 'bad', unknown: 'neutral', loading: 'neutral' }
const disks = computed(() => src.data.value ?? [])
const failing = computed(() => disks.value.filter(d => smartStatus(d) === 'failed' || smartStatus(d) === 'warning').length)
</script>

<template>
  <Empty v-if="src.data.value && !disks.length" :icon="HardDriveIcon" :text="t('widgets.disks.none')" />
  <div v-else-if="src.data.value" class="flex flex-1 flex-col gap-2">
    <p class="text-xs" :class="failing ? 'text-warning' : 'text-base-content/70'">
      {{ failing ? t('widgets.disks.attention', failing) : t('widgets.disks.allGood', disks.length) }}
    </p>
    <ul class="flex flex-col divide-y divide-base-300">
      <li v-for="d in disks.slice(0, ROWS[props.size])" :key="d.device" class="flex items-center gap-2 py-1.5 text-xs">
        <span :class="['size-2 shrink-0 rounded-full', DOT[TONE[smartStatus(d)]]]" aria-hidden="true" />
        <span class="font-mono text-base-content">{{ d.device }}</span>
        <span v-if="props.size !== 's'" class="min-w-0 flex-1 truncate text-base-content/60">{{ d.modelName ?? '' }}</span>
        <span v-else class="flex-1" />
        <span v-if="d.temperature > 0" class="tabular-nums text-base-content/80">{{ d.temperature }} °C</span>
        <span :class="['shrink-0', TONE[smartStatus(d)] === 'ok' ? 'text-base-content/70' : TEXT[TONE[smartStatus(d)]]]">{{ t(`widgets.disks.status.${smartStatus(d)}`) }}</span>
      </li>
    </ul>
  </div>
</template>
