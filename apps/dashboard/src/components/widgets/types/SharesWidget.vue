<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { UsersIcon } from '@lucide/vue'
import { ROWS } from '../kit/tone'
import { reportSources } from '../card-status'
import { now, useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import { relativeTime } from '../../../lib/relative-time'
import type { LiveSession } from '../../../lib/share-activity'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t, locale } = useI18n()
const sessions = useSource('share-sessions', () => trpc.sharing.sessions.query() as Promise<LiveSession[]>, 20_000)
const links = useSource('share-links', () => trpc.shareLink.listMine.query(), 120_000)
reportSources(sessions, links)

const people = computed(() => new Set((sessions.data.value ?? []).map(s => s.user)).size)
const active = computed(() => (links.data.value ?? []).filter(l => !l.disabled && (!l.expiresAt || new Date(l.expiresAt).getTime() > now.value)))
const nextExpiry = computed(() => active.value.map(l => l.expiresAt).filter((d): d is NonNullable<typeof d> => !!d).sort((a, b) => +new Date(a) - +new Date(b))[0] ?? null)
</script>

<template>
  <div class="flex flex-1 flex-col gap-3">
    <div class="flex flex-wrap items-end gap-x-6 gap-y-2">
      <p class="text-xs text-base-content/70"><span class="font-figure text-2xl font-bold tabular-nums text-base-content">{{ people }}</span> {{ t('widgets.shares.connected', people) }}</p>
      <p class="text-xs text-base-content/70"><span class="font-figure text-2xl font-bold tabular-nums text-base-content">{{ active.length }}</span> {{ t('widgets.shares.links', active.length) }}</p>
    </div>
    <ul v-if="props.size !== 's' && sessions.data.value?.length" class="flex flex-col divide-y divide-base-300 text-xs">
      <li v-for="(s, i) in sessions.data.value.slice(0, ROWS[props.size])" :key="i" class="flex items-center gap-2 py-1.5">
        <UsersIcon class="size-3.5 shrink-0 text-base-content/60" aria-hidden="true" />
        <span class="font-medium text-base-content">{{ s.user }}</span>
        <span class="min-w-0 flex-1 truncate text-base-content/70">{{ s.share }}</span>
        <span class="shrink-0 text-base-content/60">{{ relativeTime(s.connectedAt, now, locale) }}</span>
      </li>
    </ul>
    <p v-if="nextExpiry" class="mt-auto text-xs text-base-content/60">{{ t('widgets.shares.nextExpiry', { at: relativeTime(nextExpiry, now, locale) }) }}</p>
  </div>
</template>
