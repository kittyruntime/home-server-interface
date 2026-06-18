<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { trpc } from '../../../lib/trpc'
import { useNotifications } from '../../../lib/notifications'

// Mirrors apps/backend/src/trpc/routers/fs.ts MAX_TEXT_PREVIEW_BYTES — used
// here only to skip a doomed network round-trip; the backend is the real
// authority (it re-checks via stat() before ever reading the file).
const MAX_TEXT_PREVIEW_BYTES = 3 * 1024 * 1024

const props = defineProps<{ path: string; name: string; size: number | null }>()
const emit = defineEmits<{ dirty: [boolean] }>()

const { track } = useNotifications()

const state = ref<'loading' | 'binary' | 'too-large' | 'error' | 'ready'>('loading')
const fileSize = ref<number | null>(props.size)
const saving = ref(false)
const dirty = ref(false)

const editorEl = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null
const languageConf = new Compartment()

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--c-surface)', color: 'var(--c-text-1)', height: '100%', fontSize: '13px' },
  '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--c-accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--c-accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--c-accent-subtle) !important' },
  '.cm-gutters': { backgroundColor: 'var(--c-surface)', color: 'var(--c-text-3)', border: 'none', borderRight: '1px solid var(--c-border)' },
  '.cm-activeLine': { backgroundColor: 'var(--c-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--c-hover)' },
  '&.cm-focused': { outline: 'none' },
})

function setupEditor(content: string) {
  if (!editorEl.value) return
  view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        history(),
        keymap.of([
          ...defaultKeymap, ...historyKeymap, indentWithTab,
          { key: 'Mod-s', preventDefault: true, run: () => { save(); return true } },
        ]),
        languageConf.of([]),
        theme,
        EditorView.updateListener.of(update => {
          if (update.docChanged) { dirty.value = true; emit('dirty', true) }
        }),
      ],
    }),
    parent: editorEl.value,
  })

  const langDesc = LanguageDescription.matchFilename(languages, props.name)
  langDesc?.load().then(support => {
    view?.dispatch({ effects: languageConf.reconfigure(support) })
  })
}

async function load() {
  if (fileSize.value != null && fileSize.value > MAX_TEXT_PREVIEW_BYTES) {
    state.value = 'too-large'
    return
  }
  try {
    const res = await trpc.fs.readText.query({ path: props.path })
    if (!res.ok) {
      fileSize.value = res.size
      state.value = res.reason
      return
    }
    fileSize.value = res.size
    state.value = 'ready'
    setupEditor(res.content)
  } catch {
    state.value = 'error'
  }
}

async function save() {
  if (!view || saving.value) return
  saving.value = true
  try {
    await track(`Saving ${props.name}`, () =>
      trpc.fs.writeText.mutate({ path: props.path, content: view!.state.doc.toString() })
    )
    dirty.value = false
    emit('dirty', false)
  } catch { /* surfaced via the inline status notification */ } finally {
    saving.value = false
  }
}

defineExpose({ save })

onMounted(load)
onBeforeUnmount(() => view?.destroy())
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div v-if="state === 'loading'" class="flex-1 flex items-center justify-center text-[var(--c-text-3)] text-sm">
      [LOADING]
    </div>

    <div v-else-if="state === 'binary'" class="flex-1 flex items-center justify-center text-[var(--c-text-3)] text-sm">
      <div class="text-center space-y-1">
        <p>Binary file — preview not available.</p>
        <p class="status-text">{{ name }} · {{ fileSize ?? 0 }} bytes</p>
      </div>
    </div>

    <div v-else-if="state === 'too-large'" class="flex-1 flex items-center justify-center text-[var(--c-text-3)] text-sm">
      <div class="text-center space-y-1">
        <p>File too large to edit here ({{ ((fileSize ?? 0) / 1024 / 1024).toFixed(1) }} MB).</p>
        <p class="status-text">Use Download instead.</p>
      </div>
    </div>

    <div v-else-if="state === 'error'" class="flex-1 flex items-center justify-center text-[var(--c-accent)] text-sm">
      [ERR] Failed to load file
    </div>

    <div v-show="state === 'ready'" ref="editorEl" class="flex-1 overflow-auto min-h-0" />
  </div>
</template>
