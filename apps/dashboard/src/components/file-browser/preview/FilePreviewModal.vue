<script setup lang="ts">
import { ref, computed, defineAsyncComponent } from 'vue'
import Modal from '../../ui/Modal.vue'
import MediaPreview from './MediaPreview.vue'
import { detectKind } from '../../../lib/file-kind'
import { useAuth } from '../../../lib/auth'
import { downloadUrl } from '../../../lib/file-url'

type Entry = { name: string; path: string; size: number | null }

const props = defineProps<{ entry: Entry }>()
const emit = defineEmits<{ close: [] }>()

const { token } = useAuth()
const kind = computed(() => detectKind(props.entry.name))
const ext = computed(() => props.entry.name.includes('.') ? props.entry.name.split('.').pop()!.toUpperCase() : '')

// Code-split: CodeMirror only loads when a text file is actually opened.
const CodeEditor = defineAsyncComponent(() => import('./CodeEditor.vue'))

const editorRef = ref<{ save: () => void } | null>(null)
const dirty = ref(false)

function tryClose() {
  if (dirty.value && !confirm('Discard unsaved changes?')) return
  emit('close')
}
</script>

<template>
  <Modal panel-class="w-[92vw] h-[88vh] max-w-6xl flex flex-col" @close="tryClose">
    <template #header>
      <div class="flex items-center gap-2.5 min-w-0">
        <span class="text-sm font-medium text-[var(--c-text-1)] truncate" :title="entry.name">{{ entry.name }}</span>
        <span v-if="ext" class="badge badge-muted shrink-0">{{ ext }}</span>
        <span v-if="dirty" class="status-text text-[var(--c-warning)] shrink-0">[UNSAVED]</span>
      </div>
      <a
        :href="downloadUrl(entry.path, token ?? '')"
        :download="entry.name"
        title="Download"
        class="font-mono text-xs text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors shrink-0"
      >[DL]</a>
    </template>

    <MediaPreview v-if="kind === 'image' || kind === 'video' || kind === 'audio'" :path="entry.path" :kind="kind" />
    <CodeEditor
      v-else
      ref="editorRef"
      :path="entry.path"
      :name="entry.name"
      :size="entry.size"
      @dirty="dirty = $event"
    />

    <template v-if="kind === 'text'" #footer>
      <div class="flex-1" />
      <button class="btn btn-ghost btn-sm" @click="tryClose">Close</button>
      <button class="btn btn-primary btn-sm" :disabled="!dirty" @click="editorRef?.save()">Save</button>
    </template>
  </Modal>
</template>
