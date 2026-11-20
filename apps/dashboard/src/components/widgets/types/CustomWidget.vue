<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { BracesIcon } from '@lucide/vue'
import Empty from '../kit/Empty.vue'
import Figure from '../kit/Figure.vue'
import Meter from '../kit/Meter.vue'
import Spark from '../kit/Spark.vue'
import { DOT, ROWS, TEXT } from '../kit/tone'
import { reportSources } from '../card-status'
import { now, useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import { customOf, type CustomConfig } from '../../../lib/widget-custom'
import { evaluate, formatValue, levelOf, toNumber } from '../../../lib/widget-expr'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

// A widget fed by the admin's data sources: an expression over their values,
// written in the chosen format and shown as a figure, a gauge, a curve, a
// state, a list or text. `config` previews settings not saved yet.

const props = defineProps<{ widget: BoardWidget; size: WidgetSize; config?: CustomConfig }>()
const { t, locale } = useI18n()
const cfg = computed(() => props.config ?? customOf(props.widget.settings))
const ids = cfg.value.sources
const chart = cfg.value.display === 'chart'
const src = ids.length
  ? useSource(`custom:${ids.join(',')}:${chart}`, () => trpc.widgetSource.data.query({ ids, history: chart }), 30_000)
  : null
if (src) reportSources(src)

const rows = computed(() => ids.map(id => src?.data.value?.find(d => d.id === id)))
const scope = computed(() => ({ sources: rows.value.map(r => r?.value) }))
const sourceError = computed(() => rows.value.find(r => r?.error)?.error ?? null)
const missing = computed(() => src?.data.value && rows.value.some(r => !r))

function safe(expr: string, item?: unknown): unknown {
  try { return evaluate(expr, { ...scope.value, item }) } catch { return undefined }
}
const fmt = (v: unknown, c: CustomConfig = cfg.value) => formatValue(v, {
  format: c.format, decimals: c.decimals, prefix: c.prefix, unit: c.unit, locale: locale.value, now: now.value,
  yes: c.yes || t('widgets.custom.yes'), no: c.no || t('widgets.custom.no'),
})

const value = computed(() => safe(cfg.value.value))
const level = computed(() => levelOf(value.value, cfg.value.warn, cfg.value.bad, cfg.value.below))
const toneClass = computed(() => level.value && level.value !== 'ok' ? TEXT[level.value] : undefined)
const caption = computed(() => {
  const c = cfg.value.caption
  if (!c) return undefined
  // Text that is not an expression is shown as written.
  const v = safe(c)
  if (v === undefined) return c
  return formatValue(v, { format: cfg.value.captionFormat ?? 'text', locale: locale.value, now: now.value })
})
const gauge = computed(() => {
  const n = toNumber(value.value), lo = toNumber(cfg.value.min) ?? 0, hi = toNumber(cfg.value.max) ?? 100
  return n == null || hi === lo ? 0 : ((n - lo) / (hi - lo)) * 100
})
const history = computed(() => (rows.value[0]?.history ?? []).map(p => p.v))
// The curve spans the values it holds, so a slow change stays visible.
const range = computed(() => {
  const lo = Math.min(...history.value), hi = Math.max(...history.value)
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.01 || 1
  return { lo: lo - pad, hi: hi + pad }
})
const items = computed(() => {
  const l = cfg.value.list
  if (cfg.value.display !== 'list' || !l?.path) return []
  const list = safe(l.path)
  return Array.isArray(list) ? list.slice(0, ROWS[props.size] + 3).map(item => ({ label: safe(l.label, item), value: safe(l.value, item) })) : []
})
const state = computed(() => {
  if (level.value) return level.value
  const v = value.value
  const yes = v === true || v === 1 || (typeof v === 'string' && /^(true|yes|on|ok|up|running|healthy)$/i.test(v))
  return yes ? 'ok' : 'bad'
})
// List items take the thresholds when they are numbers.
const itemTone = (v: unknown) => {
  const l = levelOf(v, cfg.value.warn, cfg.value.bad, cfg.value.below)
  return l && l !== 'ok' ? TEXT[l] : 'text-base-content/80'
}
const text = (v: unknown) => v === undefined || v === null ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v)
</script>

<template>
  <Empty v-if="!ids.length" :icon="BracesIcon" :text="t('widgets.custom.unset')" />
  <Empty v-else-if="missing" :icon="BracesIcon" :text="t('widgets.custom.missing')" />
  <p v-else-if="sourceError && value === undefined" class="status-text text-error"><span class="status-tag">[ERR]</span> {{ sourceError }}</p>
  <div v-else class="flex min-h-0 flex-1 flex-col gap-3">
    <template v-if="cfg.display === 'number' || cfg.display === 'gauge' || cfg.display === 'chart'">
      <Figure :value="fmt(value)" :sub="caption" :tone-class="toneClass" />
      <Meter v-if="cfg.display === 'gauge'" :value="gauge" :tone="level ?? 'ok'" />
      <div v-if="cfg.display === 'chart'" class="min-h-10 flex-1">
        <Spark v-if="history.length > 1" :values="history" :min="range.lo" :max="range.hi" />
        <p v-else class="text-xs text-base-content/60">{{ t('widgets.custom.noHistory') }}</p>
      </div>
    </template>
    <div v-else-if="cfg.display === 'status'" class="flex flex-1 flex-col justify-center gap-1.5">
      <p class="flex items-center gap-2 text-lg font-semibold">
        <span :class="['size-3 rounded-full', DOT[state]]" aria-hidden="true" />
        <span :class="state === 'ok' ? 'text-base-content' : TEXT[state]">{{ state === 'ok' ? (cfg.yes || t('widgets.custom.yes')) : (cfg.no || t('widgets.custom.no')) }}</span>
      </p>
      <p class="text-xs text-base-content/70">{{ caption ?? (level ? fmt(value) : '') }}</p>
    </div>
    <template v-else-if="cfg.display === 'list'">
      <p class="text-xs text-base-content/70"><span class="font-figure text-2xl font-bold tabular-nums" :class="toneClass ?? 'text-base-content'">{{ fmt(value) }}</span> <span v-if="caption">{{ caption }}</span></p>
      <ul class="flex flex-col divide-y divide-base-300 text-xs">
        <li v-for="(it, i) in items" :key="i" class="flex items-baseline gap-2 py-1.5">
          <span class="min-w-0 flex-1 truncate text-base-content">{{ text(it.label) }}</span>
          <span :class="['max-w-[55%] shrink-0 truncate tabular-nums', itemTone(it.value)]">{{ cfg.list?.format ? formatValue(it.value, { format: cfg.list.format, locale, now }) : text(it.value) }}</span>
        </li>
      </ul>
    </template>
    <pre v-else class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap font-mono text-2xs leading-relaxed text-base-content/90">{{ text(value) }}</pre>
  </div>
</template>
