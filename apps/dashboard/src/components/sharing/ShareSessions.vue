<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { MonitorIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import BusyLabel from '../ui/BusyLabel.vue'
import { relativeTime } from '../../lib/relative-time'
import { formatDateTime } from '../../lib/format-date'
import type { ShareSession } from '../../lib/sharing-types'

defineProps<{ sessions: ShareSession[]; canDisconnect?: boolean; title?: string; busyKey?: string | null }>()
const emit = defineEmits<{ disconnect: [s: ShareSession] }>()
const { t, locale } = useI18n()

/** One line per person, share and machine (the server groups them). */
function keyOf(s: ShareSession): string {
  return `${s.share}|${s.user}|${s.ip || s.client}`
}
</script>

<template>
  <section class="space-y-2">
    <h4 class="text-sm font-semibold text-base-content">{{ title ?? t('sharing.detail.now') }}</h4>
    <p v-if="sessions.length === 0" class="text-sm text-base-content/70">{{ t('sharing.detail.nobody') }}</p>
    <ul v-else class="divide-y divide-base-300/70">
      <li v-for="s in sessions" :key="keyOf(s)" class="flex items-center gap-3 py-2">
        <MonitorIcon class="size-4 shrink-0 text-success" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm text-base-content">
            <span class="font-medium">{{ s.user || t('sharing.detail.guest') }}</span>
            <template v-if="s.client"><span class="text-base-content/50"> · </span><span class="font-mono text-xs">{{ s.client.toLowerCase() }}</span></template>
          </p>
          <p class="truncate text-xs text-base-content/70">
            <template v-if="s.ip && s.ip !== s.client"><span class="font-mono">{{ s.ip }}</span> · </template>
            <span :title="formatDateTime(s.connectedAt)">{{ t('sharing.detail.since', { time: relativeTime(s.connectedAt, Date.now(), locale) }) }}</span>
          </p>
        </div>
        <Button v-if="canDisconnect && s.pids.length" variant="ghost" size="xs" class="shrink-0 text-error" :disabled="!!busyKey" @click="emit('disconnect', s)">
          <BusyLabel :busy="busyKey === keyOf(s)">{{ t('sharing.detail.disconnect') }}</BusyLabel>
        </Button>
      </li>
    </ul>
  </section>
</template>
