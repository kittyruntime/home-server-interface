<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderIcon } from '@lucide/vue'
import Empty from '../kit/Empty.vue'
import PlaceIcon from '../../PlaceIcon.vue'
import { ROWS } from '../kit/tone'
import { reportSources } from '../card-status'
import { useSource } from '../../../lib/widget-data'
import { trpc } from '../../../lib/trpc'
import { focusFolder } from '../../../lib/app-focus'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const src = useSource('places', () => trpc.place.list.query(), 300_000)
reportSources(src)
const places = computed(() => (src.data.value ?? []).slice(0, ROWS[props.size] + (props.size === 's' ? 0 : 1)))
</script>

<template>
  <Empty v-if="src.data.value && !src.data.value.length" :icon="FolderIcon" :text="t('widgets.places.none')" />
  <ul v-else class="-mx-2 flex flex-1 flex-col">
    <li v-for="p in places" :key="p.id">
      <button type="button" class="flex w-full items-center gap-2.5 rounded-field px-2 py-1.5 text-left hover:bg-base-200" @click="focusFolder(p.path)">
        <PlaceIcon :icon="p.icon" class="size-4 shrink-0 text-base-content/70" />
        <span class="min-w-0 flex-1 truncate text-sm text-base-content">{{ p.name }}</span>
        <span v-if="props.size === 'l'" class="max-w-[50%] truncate font-mono text-2xs text-base-content/60">{{ p.path }}</span>
      </button>
    </li>
  </ul>
</template>
