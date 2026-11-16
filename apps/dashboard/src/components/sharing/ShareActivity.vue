<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { relativeTime } from '../../lib/relative-time'
import { formatDateTime } from '../../lib/format-date'
import { eventKey, reasonKey } from '../../lib/share-reasons'
import type { ShareEventRow } from '../../lib/sharing-types'

defineProps<{ events: ShareEventRow[]; title?: string; showUser?: boolean; seeAll?: boolean; hideTitle?: boolean }>()
const emit = defineEmits<{ seeAll: [] }>()
const { t, locale } = useI18n()

function sentence(e: ShareEventRow): string {
  const what = t(eventKey(e), { share: e.share })
  return e.result === 'refused' ? t('sharing.event.withReason', { what, reason: t(reasonKey(e.reason)) }) : what
}
</script>

<template>
  <section class="space-y-2">
    <div v-if="!hideTitle" class="flex items-center justify-between gap-2">
      <h4 class="eyebrow">{{ title ?? t('sharing.detail.activity') }}</h4>
      <button v-if="seeAll" type="button" class="link link-primary text-xs" @click="emit('seeAll')">{{ t('sharing.detail.seeAll') }}</button>
    </div>
    <p v-if="events.length === 0" class="text-sm text-base-content/70">{{ t('sharing.detail.noActivity') }}</p>
    <ul v-else class="space-y-1.5">
      <li v-for="e in events" :key="e.id" class="grid grid-cols-[5.5rem_1fr] gap-x-3 text-sm">
        <span class="text-xs text-base-content/70 tabular-nums" :title="formatDateTime(e.at)">{{ relativeTime(e.at, Date.now(), locale) }}</span>
        <span class="min-w-0" :class="e.result === 'refused' ? 'text-error' : 'text-base-content'">
          <template v-if="showUser && e.user"><strong class="font-medium">{{ e.user }}</strong> · </template>{{ sentence(e) }}
          <span v-if="e.machine || e.ip" class="ml-1 text-xs text-base-content/70">{{ t('sharing.event.from', { where: e.machine || e.ip }) }}</span>
        </span>
      </li>
    </ul>
  </section>
</template>
