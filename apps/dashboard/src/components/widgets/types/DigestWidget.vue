<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { SparklesIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import Empty from '../kit/Empty.vue'
import { useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import { formatDateTime } from '../../../lib/format-date'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t, locale } = useI18n()
const lang = computed(() => locale.value === 'fr' ? 'fr' : 'en')
const l = lang.value
const src = useSource(`digest:${l}`, () => trpc.dashboard.digest.query({ locale: l }), 600_000)
const busy = ref(false)
const error = ref<string | null>(null)

async function write() {
  busy.value = true
  error.value = null
  try {
    await trpc.dashboard.writeDigest.mutate({ locale: l })
    await src.refresh()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex flex-1 flex-col gap-3">
    <template v-if="src.data.value">
      <p class="text-sm leading-relaxed text-base-content">{{ src.data.value.text }}</p>
      <p class="mt-auto flex items-center gap-2 text-xs text-base-content/60">
        <span>{{ t('widgets.digest.writtenAt', { at: formatDateTime(src.data.value.at) }) }}</span>
        <Button variant="ghost" size="xs" :disabled="busy" @click="write">{{ busy ? t('widgets.digest.writing') : t('widgets.digest.rewrite') }}</Button>
      </p>
    </template>
    <Empty v-else :icon="SparklesIcon" :text="t('widgets.digest.none')">
      <Button variant="outline" size="sm" class="mt-1" :disabled="busy" @click="write">{{ busy ? t('widgets.digest.writing') : t('widgets.digest.write') }}</Button>
    </Empty>
    <p v-if="error" class="status-text text-error"><span class="status-tag">[ERR]</span> {{ error }}</p>
  </div>
</template>
