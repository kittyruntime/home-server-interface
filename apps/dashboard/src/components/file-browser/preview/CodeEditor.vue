<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { WrapTextIcon } from '@lucide/vue'
import LoadingState from '../../ui/LoadingState.vue'
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment, EditorSelection } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { LanguageDescription, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as tg } from '@lezer/highlight'
import { languages } from '@codemirror/language-data'
import { trpc } from '../../../lib/trpc'
import { getFormatter, formatContent } from '../../../lib/formatters'
import { useNotifications } from '../../../lib/notifications'

const { t } = useI18n()

// Mirrors apps/backend/src/trpc/routers/fs.ts MAX_TEXT_PREVIEW_BYTES, used
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
const formatting = ref(false)
const formatter = computed(() => getFormatter(props.name))

const editorEl = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null
const languageConf = new Compartment()

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--color-base-100)', color: 'var(--color-base-content)', height: '100%', fontSize: 'var(--text-control)' },
  '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--color-primary)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--color-primary) 10%, transparent) !important' },
  '.cm-gutters': { backgroundColor: 'var(--color-base-100)', color: 'color-mix(in oklab, var(--color-base-content) 70%, transparent)', border: 'none', borderRight: '1px solid var(--color-border)' },
  '.cm-activeLine': { backgroundColor: 'var(--color-base-200)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--color-base-200)' },
  '&.cm-focused': { outline: 'none' },
})

// Token colors are CSS variables, so they follow the active daisyUI theme without a rebuild.
// Saturated theme colors are mixed toward the content color where they could fail on some themes.
const soften = (color: string) => `color-mix(in oklab, var(${color}) 70%, var(--color-base-content))`
const highlightStyle = HighlightStyle.define([
  { tag: [tg.keyword, tg.modifier, tg.operatorKeyword, tg.controlKeyword], color: soften('--color-primary') },
  { tag: [tg.string, tg.special(tg.string), tg.regexp], color: soften('--color-success') },
  { tag: [tg.number, tg.bool, tg.null, tg.atom], color: soften('--color-warning') },
  { tag: [tg.comment, tg.lineComment, tg.blockComment], color: 'color-mix(in oklab, var(--color-base-content) 55%, transparent)', fontStyle: 'italic' },
  { tag: [tg.variableName, tg.name], color: 'var(--color-base-content)' },
  { tag: [tg.typeName, tg.className, tg.namespace], color: soften('--color-secondary') },
  { tag: [tg.function(tg.variableName), tg.function(tg.propertyName)], color: soften('--color-info') },
  { tag: [tg.propertyName, tg.attributeName], color: soften('--color-accent') },
  { tag: tg.operator, color: 'color-mix(in oklab, var(--color-base-content) 80%, transparent)' },
  { tag: [tg.punctuation, tg.separator, tg.bracket], color: 'color-mix(in oklab, var(--color-base-content) 65%, transparent)' },
  { tag: tg.heading, color: soften('--color-primary'), fontWeight: 'bold' },
  { tag: [tg.link, tg.url], color: soften('--color-info'), textDecoration: 'underline' },
  { tag: [tg.meta, tg.processingInstruction, tg.documentMeta], color: 'color-mix(in oklab, var(--color-base-content) 60%, transparent)' },
  { tag: tg.invalid, color: 'var(--color-error)' },
])

function setupEditor(content: string) {
  if (!editorEl.value) return
  view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        syntaxHighlighting(highlightStyle),
        basicSetup,
        history(),
        keymap.of([
          ...defaultKeymap, ...historyKeymap, indentWithTab,
          { key: 'Mod-s', preventDefault: true, run: () => { save(); return true } },
          { key: 'Shift-Alt-f', preventDefault: true, run: () => { format(); return true } },
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

async function format() {
  if (!view || formatting.value) return
  if (!formatter.value) return
  formatting.value = true
  try {
    await track(`Formatting ${props.name}`, async () => {
      const current = view!.state.doc.toString()
      const cursorOffset = view!.state.selection.main.head
      const { formatted, cursorOffset: newCursor } = await formatContent(props.name, current, cursorOffset)
      if (view!.state.doc.toString() !== current) {
        throw new Error(t('uis.files.CodeEditor.fileChangedWhileFormattingTry'))
      }
      if (formatted !== current) {
        const clamped = Math.min(Math.max(newCursor, 0), formatted.length)
        view!.dispatch({
          changes: { from: 0, to: current.length, insert: formatted },
          selection: EditorSelection.cursor(clamped),
        })
      }
    })
  } catch { /* surfaced via the inline status notification */ } finally {
    formatting.value = false
  }
}

defineExpose({ save })

onMounted(load)
onBeforeUnmount(() => view?.destroy())
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <LoadingState v-if="state === 'loading'" class="flex-1" />

    <div v-else-if="state === 'binary'" class="flex-1 flex items-center justify-center text-base-content/70 text-sm">
      <div class="text-center space-y-1">
        <p>{{ t('ui.files.CodeEditor.binaryFilePreviewNotAvailable') }}</p>
        <p class="status-text">{{ t('uip.files.CodeEditor.bytes', { p0: name, p1: fileSize ?? 0 }) }}</p>
      </div>
    </div>

    <div v-else-if="state === 'too-large'" class="flex-1 flex items-center justify-center text-base-content/70 text-sm">
      <div class="text-center space-y-1">
        <p>{{ t('uip.files.CodeEditor.fileTooLargeToEdit', { p0: ((fileSize ?? 0) / 1024 / 1024).toFixed(1) }) }}</p>
        <p class="status-text">{{ t('ui.files.CodeEditor.useDownloadInstead') }}</p>
      </div>
    </div>

    <div v-else-if="state === 'error'" class="flex-1 flex items-center justify-center text-primary text-sm">
      {{ t('ui.files.CodeEditor.errFailedToLoadFile') }}
    </div>

    <div v-show="state === 'ready'" class="relative flex-1 min-h-0">
      <Button variant="ghost" size="icon-sm"
        v-if="formatter"
        type="button"
        :tooltip="t('ui.files.CodeEditor.formatShiftAltF')" :aria-label="t('ui.files.CodeEditor.formatShiftAltF')"
        class="absolute top-2 right-4 z-10 bg-base-100 border border-base-300 text-base-content/70 hover:text-base-content shadow-sm"
        :disabled="formatting"
        @click="format"
      >
        <WrapTextIcon class="w-4 h-4" aria-hidden="true" />
      </Button>
      <div ref="editorEl" class="h-full overflow-auto" />
    </div>
  </div>
</template>
