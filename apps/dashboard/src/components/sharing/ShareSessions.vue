<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { relativeTime } from '../../lib/relative-time'
import { formatDateTime } from '../../lib/format-date'
import type { ShareSession } from '../../lib/sharing-types'

defineProps<{ sessions: ShareSession[]; canDisconnect?: boolean; title?: string }>()
const emit = defineEmits<{ disconnect: [s: ShareSession] }>()
const { t, locale } = useI18n()
</script>

<template>
  <section class="space-y-2">
    <h4 class="eyebrow">{{ title ?? t('sharing.detail.now') }}</h4>
    <p v-if="sessions.length === 0" class="text-sm text-base-content/70">{{ t('sharing.detail.nobody') }}</p>
    <ul v-else class="space-y-1.5">
      <li v-for="s in sessions" :key="`${s.pid}-${s.share}-${s.connectedAt}`" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span class="font-medium text-base-content">{{ s.user || t('sharing.detail.guest') }}</span>
        <span class="text-xs text-base-content/70">{{ s.client }}<template v-if="s.ip && s.ip !== s.client"> · {{ s.ip }}</template></span>
        <span class="text-xs text-base-content/70" :title="formatDateTime(s.connectedAt)">{{ t('sharing.detail.since', { time: relativeTime(s.connectedAt, Date.now(), locale) }) }}</span>
        <Button v-if="canDisconnect && s.pid" variant="ghost" size="xs" class="ml-auto" @click="emit('disconnect', s)">{{ t('sharing.detail.disconnect') }}</Button>
      </li>
    </ul>
  </section>
</template>
