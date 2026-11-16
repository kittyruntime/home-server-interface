<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderOpenIcon, KeyRoundIcon, LogOutIcon, ShieldAlertIcon } from '@lucide/vue'
import { relativeTime } from '../../lib/relative-time'
import { formatDateTime } from '../../lib/format-date'
import { eventKey, reasonKey } from '../../lib/share-reasons'
import { collapseRuns, groupByDay, isVisit, machineLabel, type ActivityRun, type LiveSession } from '../../lib/share-activity'
import type { ShareEventRow } from '../../lib/sharing-types'

const props = defineProps<{
  events: ShareEventRow[]
  title?: string
  showUser?: boolean
  seeAll?: boolean
  hideTitle?: boolean
  /** Journal layout: day headings and clock times instead of "5 minutes ago". */
  byDay?: boolean
  /** Show at most this many lines (after repeats are folded together). */
  maxLines?: number
  /** Who is connected now: their visit is still going on. */
  sessions?: LiveSession[]
}>()
const emit = defineEmits<{ seeAll: [] }>()
const { t, locale } = useI18n()

const runs = computed(() => {
  const all = collapseRuns(props.events, props.sessions)
  return props.maxLines ? all.slice(0, props.maxLines) : all
})
const days = computed(() => props.byDay
  ? groupByDay(runs.value, Date.now(), locale.value)
  : [{ key: 'all', label: '', runs: runs.value }])

type Run = ActivityRun<ShareEventRow>

function icon(e: ShareEventRow) {
  if (e.result === 'refused') return ShieldAlertIcon
  if (e.kind === 'disconnect') return LogOutIcon
  return e.kind === 'auth' ? KeyRoundIcon : FolderOpenIcon
}

const clock = computed(() => new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' }))
const ongoing = (r: Run) => !!r.visit && r.visit.end === null
function when(r: Run): string {
  if (ongoing(r)) {
    return props.byDay
      ? t('sharing.event.sinceClock', { time: clock.value.format(r.earliest) })
      : relativeTime(r.earliest, Date.now(), locale.value)
  }
  if (!props.byDay) return relativeTime(r.latest, Date.now(), locale.value)
  const end = clock.value.format(r.latest)
  const start = clock.value.format(r.earliest)
  return start === end ? end : `${start} – ${end}`
}
</script>

<template>
  <section class="space-y-2">
    <div v-if="!hideTitle" class="flex items-center justify-between gap-2">
      <h4 class="eyebrow">{{ title ?? t('sharing.detail.activity') }}</h4>
      <button v-if="seeAll && events.length" type="button" class="link link-primary text-xs" @click="emit('seeAll')">{{ t('sharing.detail.seeAll') }}</button>
    </div>
    <p v-if="events.length === 0" class="text-sm text-base-content/70">{{ t('sharing.detail.noActivity') }}</p>
    <template v-else>
    <div v-for="(d, i) in days" :key="d.key" class="space-y-1" :class="i > 0 && 'pt-3'">
      <h5 v-if="byDay" class="text-xs font-semibold text-base-content/70">{{ d.label }}</h5>
      <ul class="divide-y divide-base-300/70">
        <li v-for="r in d.runs" :key="r.first.id" class="flex items-start gap-3 py-1.5">
          <component :is="icon(r.first)" class="mt-0.5 size-4 shrink-0" :class="r.first.result === 'refused' ? 'text-error' : 'text-base-content/50'" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="text-sm text-base-content">
              <template v-if="showUser && r.first.user"><span class="font-medium">{{ r.first.user }}</span><span class="text-base-content/50"> · </span></template>
              <span>{{ t(eventKey(r.first), { share: r.first.share }) }}</span>
              <template v-if="r.first.result === 'refused'"><span class="text-base-content/50"> · </span><span class="text-error">{{ t(reasonKey(r.first.reason)) }}</span></template>
              <span v-if="machineLabel(r.first)" class="ml-2 whitespace-nowrap text-xs text-base-content/70">{{ t('sharing.event.fromLabel') }} <span class="font-mono">{{ machineLabel(r.first) }}</span></span>
              <span v-if="ongoing(r)" class="badge badge-sm ml-2 align-text-bottom border-success/30 bg-success/10 text-success">{{ t('sharing.event.stillConnected') }}</span>
              <span v-if="r.count > 1 && !isVisit(r.first)" class="badge badge-ghost badge-sm ml-2 align-text-bottom tabular-nums">{{ t('sharing.event.times', { n: r.count }, r.count) }}</span>
            </p>
          </div>
          <time class="shrink-0 pt-0.5 text-xs text-base-content/70 tabular-nums" :datetime="(ongoing(r) ? r.earliest : r.latest).toISOString()" :title="formatDateTime(ongoing(r) ? r.earliest : r.latest)">{{ when(r) }}</time>
        </li>
      </ul>
    </div>
    </template>
  </section>
</template>
