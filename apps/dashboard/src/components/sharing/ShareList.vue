<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { CircleAlertIcon } from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import type { ShareListRow } from '../../lib/sharing-types'

defineProps<{ shares: ShareListRow[]; selectedId: string | null; unavailable: (path: string) => boolean }>()
const emit = defineEmits<{ select: [id: string] }>()
const { t } = useI18n()
</script>

<template>
  <ul class="divide-y divide-base-300" :aria-label="t('sharing.list.title')">
    <li v-for="s in shares" :key="s.id">
      <button
        type="button"
        class="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-(--dur-fast) hover:bg-base-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
        :class="s.id === selectedId && 'bg-primary/10 hover:bg-primary/15'"
        :aria-current="s.id === selectedId ? 'true' : undefined"
        @click="emit('select', s.id)"
      >
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-base-content" :class="!s.enabled && 'text-base-content/60'">{{ s.effectiveName }}</p>
          <p class="truncate text-xs text-base-content/70">
            {{ s.placeName }} · {{ s.readOnly ? t('sharing.list.readOnly') : t('sharing.list.readWrite') }}
          </p>
        </div>
        <Badge v-if="!s.enabled" variant="secondary">{{ t('sharing.list.disabled') }}</Badge>
        <Badge v-else-if="unavailable(s.placePath)" variant="outline" class="bg-error/10 text-error">{{ t('sharing.list.unavailable') }}</Badge>
        <span v-else-if="s.problem" class="flex shrink-0 items-center text-warning" :title="t('sharing.list.problem')">
          <CircleAlertIcon class="size-4" aria-hidden="true" /><span class="sr-only">{{ t('sharing.list.problem') }}</span>
        </span>
        <span v-else-if="s.connected > 0" class="flex shrink-0 items-center gap-1.5 text-xs font-medium text-success tabular-nums" :title="t('sharing.list.connected', { n: s.connected }, s.connected)">
          <span class="size-1.5 rounded-full bg-success" aria-hidden="true" />{{ s.connected }}<span class="sr-only">{{ t('sharing.list.connected', { n: s.connected }, s.connected) }}</span>
        </span>
      </button>
    </li>
  </ul>
</template>
