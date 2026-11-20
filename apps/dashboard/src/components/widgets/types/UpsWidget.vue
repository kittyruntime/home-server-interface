<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { BatteryWarningIcon, PlugZapIcon } from '@lucide/vue'
import Empty from '../kit/Empty.vue'
import Figure from '../kit/Figure.vue'
import Meter from '../kit/Meter.vue'
import { DOT, TEXT, type Tone } from '../kit/tone'
import { reportSources } from '../card-status'
import { useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const src = useSource('ups', () => trpc.dashboard.ups.query(), 15_000)
reportSources(src)

const ups = computed(() => src.data.value?.[0] ?? null)
const state = computed<{ key: string; tone: Tone }>(() => {
  const s = ups.value?.status ?? []
  if (s.includes('LB')) return { key: 'low', tone: 'bad' }
  if (s.includes('OB')) return { key: 'battery', tone: 'warn' }
  if (s.includes('OL')) return { key: 'line', tone: 'ok' }
  return { key: 'unknown', tone: 'neutral' }
})
const runtime = computed(() => {
  const r = ups.value?.runtimeS
  return r == null ? null : t('widgets.ups.runtime', { m: Math.round(r / 60) })
})
</script>

<template>
  <Empty v-if="src.data.value === null || (src.data.value && !src.data.value.length)" :icon="PlugZapIcon" :text="t('widgets.ups.none')" />
  <div v-else-if="ups" class="flex flex-1 flex-col justify-end gap-3">
    <p class="flex items-center gap-2 text-sm">
      <span :class="['size-2 rounded-full', DOT[state.tone]]" aria-hidden="true" />
      <span :class="['font-medium', state.tone === 'ok' ? 'text-base-content' : TEXT[state.tone]]">{{ t(`widgets.ups.state.${state.key}`) }}</span>
      <BatteryWarningIcon v-if="state.tone === 'bad'" class="size-4 text-error" aria-hidden="true" />
    </p>
    <Figure :value="ups.charge ?? '-'" unit="%" :sub="[runtime, ups.loadPct != null ? t('widgets.ups.load', { n: ups.loadPct }) : null].filter(Boolean).join(' · ')" />
    <Meter v-if="ups.charge != null" :value="ups.charge" :tone="ups.charge < 30 ? 'bad' : ups.charge < 60 ? 'warn' : 'ok'" :label="t('widgets.ups.charge')" />
    <p v-if="size !== 's'" class="truncate text-xs text-base-content/60">{{ ups.model }}</p>
  </div>
</template>
