<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleXIcon } from '@lucide/vue'
import { ROWS } from '../kit/tone'
import { reportSources } from '../card-status'
import { now, useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import { relativeTime } from '../../../lib/relative-time'
import { actionLabel } from '../../../lib/audit-labels'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t, locale } = useI18n()
const src = useSource('journal', () => trpc.audit.list.query({ limit: 40 }), 60_000)
reportSources(src)

// Layout and preference saves are not events worth reading here.
const QUIET = /^(dashboard\.|user\.savePreferences|notifications\.mark)/
const entries = computed(() => (src.data.value?.entries ?? []).filter(e => !QUIET.test(e.action)))
const refused = computed(() => entries.value.filter(e => e.action === 'auth.login' && !e.success && now.value - new Date(e.createdAt).getTime() < 86_400_000).length)
</script>

<template>
  <div class="flex flex-1 flex-col gap-2">
    <p v-if="refused" class="flex items-center gap-1.5 text-xs text-error"><CircleXIcon class="size-3.5" aria-hidden="true" />{{ t('widgets.journal.refused', { n: refused }, refused) }}</p>
    <ul class="flex flex-col divide-y divide-base-300 text-xs">
      <li v-for="e in entries.slice(0, ROWS[props.size])" :key="e.id" class="flex items-center gap-2 py-1.5">
        <span :class="['min-w-0 flex-1 truncate', e.success ? 'text-base-content' : 'text-error']">{{ actionLabel(e.action) }}<template v-if="!e.success"> · {{ t('widgets.journal.failed') }}</template></span>
        <span class="max-w-24 shrink-0 truncate text-base-content/70">{{ e.user?.displayName || e.user?.username || e.target || '-' }}</span>
        <span class="shrink-0 tabular-nums text-base-content/60">{{ relativeTime(e.createdAt, now, locale) }}</span>
      </li>
    </ul>
  </div>
</template>
