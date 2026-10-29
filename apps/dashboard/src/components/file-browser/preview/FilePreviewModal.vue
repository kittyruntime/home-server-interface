<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { DownloadIcon } from '@lucide/vue'
import { ref, computed, onMounted } from 'vue'
import Modal from '../../ui/Modal.vue'
import FilePreviewBody from './FilePreviewBody.vue'
import { detectKind } from '../../../lib/file-kind'
import { downloadUrl } from '../../../lib/file-url'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

type Entry = { name: string; path: string; size: number | null }

const props = defineProps<{ entry: Entry }>()
const emit = defineEmits<{ close: [] }>()

const downloadHref = ref<string | null>(null)
onMounted(async () => {
  try {
    downloadHref.value = await downloadUrl(props.entry.path)
  } catch { /* link stays inert until a token is available */ }
})

const kind = computed(() => detectKind(props.entry.name))
const ext = computed(() => props.entry.name.includes('.') ? props.entry.name.split('.').pop()!.toUpperCase() : '')

const bodyRef = ref<{ save: () => void } | null>(null)
const dirty = ref(false)

function tryClose() {
  if (dirty.value && !confirm(t('uis.files.FilePreviewModal.discardUnsavedChanges'))) return
  emit('close')
}
</script>

<template>
  <Modal panel-class="w-[92vw] h-[88vh] max-w-6xl flex flex-col" @close="tryClose">
    <template #header>
      <div class="flex items-center gap-2.5 min-w-0">
        <span class="text-sm font-medium text-foreground truncate" :title="entry.name">{{ entry.name }}</span>
        <Badge variant="secondary" v-if="ext" class="shrink-0">{{ ext }}</Badge>
        <span v-if="dirty" class="status-text text-warning shrink-0">[UNSAVED]</span>
      </div>
      <Button
        as="a"
        variant="ghost"
        size="icon-xs"
        :href="downloadHref ?? undefined"
        :download="entry.name"
        :tooltip="t('ui.files.FilePreviewModal.download')"
        :aria-label="t('ui.files.FilePreviewModal.download')"
        class="text-muted-foreground shrink-0"
      >
        <DownloadIcon class="w-4 h-4" aria-hidden="true" />
      </Button>
    </template>

    <FilePreviewBody :entry="entry" ref="bodyRef" @dirty="dirty = $event" />

    <template v-if="kind === 'text'" #footer>
      <div class="flex-1" />
      <Button variant="ghost" size="sm" @click="tryClose">{{ t('ui.files.FilePreviewModal.close') }}</Button>
      <Button size="sm" :disabled="!dirty" @click="bodyRef?.save()">{{ t('ui.files.FilePreviewModal.save') }}</Button>
    </template>
  </Modal>
</template>
