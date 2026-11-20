<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NotebookPenIcon } from '@lucide/vue'
import Empty from '../kit/Empty.vue'
import { renderMarkdown } from '../../../lib/markdown'
import type { BoardWidget, WidgetSize } from '../../../lib/dashboard-boards'

const props = defineProps<{ widget: BoardWidget; size: WidgetSize }>()
const { t } = useI18n()
const text = computed(() => typeof props.widget.settings?.text === 'string' ? props.widget.settings.text : '')
const html = computed(() => text.value.trim() ? renderMarkdown(text.value) : '')
</script>

<template>
  <Empty v-if="!html" :icon="NotebookPenIcon" :text="t('widgets.note.empty')" />
  <!-- eslint-disable-next-line vue/no-v-html -- escaped by renderMarkdown -->
  <div v-else class="note-md min-h-0 flex-1 overflow-y-auto text-sm text-base-content" v-html="html" />
</template>

<style scoped>
.note-md :deep(p) { margin: 0.4rem 0; line-height: 1.55; }
.note-md :deep(p:first-child) { margin-top: 0; }
.note-md :deep(.md-heading) { font-weight: 600; margin-top: 0.75rem; }
.note-md :deep(ul) { list-style: disc; padding-left: 1.25rem; margin: 0.4rem 0; }
.note-md :deep(ol) { list-style: decimal; padding-left: 1.25rem; margin: 0.4rem 0; }
.note-md :deep(code) { font-family: var(--font-mono); font-size: 0.85em; background: var(--color-base-200); border-radius: var(--radius-selector); padding: 0.05rem 0.3rem; }
.note-md :deep(a) { color: var(--color-primary); text-decoration: underline; }
</style>
