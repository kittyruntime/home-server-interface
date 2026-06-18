<script setup lang="ts">
import { ref, computed, defineAsyncComponent } from 'vue'
import MediaPreview from './MediaPreview.vue'
import { detectKind } from '../../../lib/file-kind'

type Entry = { path: string; name: string; size: number | null }

const props = defineProps<{ entry: Entry }>()
const emit = defineEmits<{ dirty: [boolean] }>()

const kind = computed(() => detectKind(props.entry.name))

// Code-split: CodeMirror only loads when a text file is actually opened.
const CodeEditor = defineAsyncComponent(() => import('./CodeEditor.vue'))

const editorRef = ref<{ save: () => void } | null>(null)

function save() {
  editorRef.value?.save()
}

defineExpose({ save })
</script>

<template>
  <MediaPreview v-if="kind === 'image' || kind === 'video' || kind === 'audio'" :path="entry.path" :kind="kind" />
  <CodeEditor
    v-else
    ref="editorRef"
    :path="entry.path"
    :name="entry.name"
    :size="entry.size"
    @dirty="emit('dirty', $event)"
  />
</template>
