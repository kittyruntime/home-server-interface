<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArchiveRestoreIcon } from '@lucide/vue'
import Empty from '../kit/Empty.vue'
import { DOT, ROWS, TEXT, type Tone } from '../kit/tone'
import { reportSources } from '../card-status'
import { now, useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import { relativeTime } from '../../../lib/relative-time'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t, locale } = useI18n()
const src = useSource('backups', () => trpc.backup.status.query(), 120_000)
reportSources(src)

type Plan = NonNullable<typeof src.data.value>['plans'][number]
function state(p: Plan): { key: string; tone: Tone } {
  if (p.progress || p.last?.status === 'running') return { key: 'running', tone: 'neutral' }
  if (!p.last) return { key: 'never', tone: 'neutral' }
  if (p.last.status === 'failed') return { key: 'failed', tone: 'bad' }
  if (p.last.warnings?.length) return { key: 'warnings', tone: 'warn' }
  return { key: 'ok', tone: 'ok' }
}
const plans = computed(() => (src.data.value?.plans ?? []).filter(p => p.enabled))
const failed = computed(() => plans.value.filter(p => state(p).tone === 'bad').length)
</script>

<template>
  <Empty v-if="src.data.value && !plans.length" :icon="ArchiveRestoreIcon" :text="t('widgets.backups.none')" />
  <div v-else-if="src.data.value" class="flex flex-1 flex-col gap-2">
    <p :class="['text-xs', failed ? 'text-error' : 'text-base-content/70']">{{ failed ? t('widgets.backups.failed', failed) : t('widgets.backups.allGood', plans.length) }}</p>
    <ul class="flex flex-col divide-y divide-base-300">
      <li v-for="p in plans.slice(0, ROWS[props.size])" :key="p.id" class="flex items-center gap-2 py-1.5 text-xs">
        <span :class="['size-2 shrink-0 rounded-full', DOT[state(p).tone], state(p).key === 'running' && 'animate-pulse bg-info']" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate font-medium text-base-content">{{ p.name }}</span>
        <span :class="['shrink-0', state(p).tone === 'ok' || state(p).tone === 'neutral' ? 'text-base-content/70' : TEXT[state(p).tone]]">
          <template v-if="state(p).key === 'running'">{{ t('widgets.backups.running', { n: Math.round(p.progress?.percentDone ?? 0) }) }}</template>
          <template v-else-if="p.last">{{ t(`widgets.backups.state.${state(p).key}`) }} {{ relativeTime(p.last.end ?? p.last.start, now, locale) }}</template>
          <template v-else>{{ t('widgets.backups.state.never') }}</template>
        </span>
        <span v-if="props.size === 'l' && p.nextRun" class="shrink-0 text-base-content/60">{{ t('widgets.backups.next', { at: relativeTime(p.nextRun, now, locale) }) }}</span>
      </li>
    </ul>
  </div>
</template>
