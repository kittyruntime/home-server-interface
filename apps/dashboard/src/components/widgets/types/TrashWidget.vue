<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2Icon } from '@lucide/vue'
import Empty from '../kit/Empty.vue'
import Figure from '../kit/Figure.vue'
import { reportSources } from '../card-status'
import { useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import { formatBytes } from '../../../lib/file-details'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const src = useSource('trash', () => trpc.trash.list.query(), 300_000)
reportSources(src)

const places = computed(() => (src.data.value ?? []).map(p => ({
  id: p.placeId, name: p.placeName, count: p.entries.length,
  size: p.entries.reduce((n, e) => n + (e.size ?? 0), 0),
})).filter(p => p.count > 0))
const total = computed(() => places.value.reduce((n, p) => n + p.size, 0))
const count = computed(() => places.value.reduce((n, p) => n + p.count, 0))
</script>

<template>
  <Empty v-if="src.data.value && !count" :icon="Trash2Icon" tone="ok" :text="t('widgets.trash.empty')" />
  <div v-else-if="src.data.value" class="flex flex-1 flex-col gap-3">
    <Figure :value="formatBytes(total)" :sub="t('widgets.trash.items', { n: count }, count)" />
    <ul v-if="props.size !== 's'" class="flex flex-col divide-y divide-base-300 text-xs">
      <li v-for="p in places" :key="p.id" class="flex items-center gap-2 py-1.5">
        <span class="min-w-0 flex-1 truncate text-base-content">{{ p.name }}</span>
        <span class="tabular-nums text-base-content/70">{{ t('widgets.trash.items', { n: p.count }, p.count) }}</span>
        <span class="w-16 text-right tabular-nums text-base-content/80">{{ formatBytes(p.size) }}</span>
      </li>
    </ul>
  </div>
</template>
