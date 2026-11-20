<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CopyIcon, PencilIcon, PlusIcon, RefreshCwIcon, XIcon } from '@lucide/vue'
import Modal from '../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import JsonTree from './JsonTree.vue'
import SourceForm from './SourceForm.vue'
import type { EditableSource } from './source-types'
import CustomWidget from './types/CustomWidget.vue'
import { trpc } from '../../lib/trpc'
import { useAuth } from '../../lib/auth'
import { copyText } from '../../lib/copy-text'
import { compactCustom, customOf, DISPLAYS, type CustomConfig } from '../../lib/widget-custom'
import { checkExpression, FORMATS } from '../../lib/widget-expr'
import type { SourceTemplate } from '../../lib/widget-templates'
import type { BoardWidget } from '../../lib/dashboard-boards'

// Settings of a custom widget: its sources ($1 to $3), what it shows and how.
// The right column previews the widget and the sources' data as a tree: a
// click on a key writes its path into the field being edited.

const props = defineProps<{ widget: BoardWidget }>()
const emit = defineEmits<{ close: []; save: [settings: Record<string, unknown> | undefined] }>()
const { t } = useI18n()
const { isAdmin } = useAuth()

const draft = reactive<CustomConfig>(customOf(props.widget.settings))
if (!draft.list) draft.list = { path: '', label: '', value: '', format: 'text' }
if (!draft.list.format) draft.list.format = 'text'
if (!draft.captionFormat) draft.captionFormat = 'text'
const title = ref(typeof props.widget.settings?.title === 'string' ? props.widget.settings.title : '')

type Listed = Awaited<ReturnType<typeof trpc.widgetSource.list.query>>[number]
const sources = ref<Listed[]>([])
async function loadSources() { sources.value = await trpc.widgetSource.list.query().catch(() => []) }
void loadSources()

// The data shown in the tree: each chosen source's last value, or a test result.
const samples = ref<Record<string, { value: unknown; error: string | null }>>({})
const tab = ref(0)
async function loadSamples() {
  const ids = draft.sources.filter(Boolean)
  if (!ids.length) return
  const rows = await trpc.widgetSource.data.query({ ids, history: false }).catch(() => [])
  for (const r of rows) samples.value[r.id] = { value: r.value, error: r.error }
}
watch(() => draft.sources.join(','), () => { void loadSamples() }, { immediate: true })
const tested = ref<{ value: unknown; error: string | null } | null>(null)
const shown = computed(() => tested.value ?? (editing.value === 'new' ? null : samples.value[editing.value ? editing.value.id : draft.sources[tab.value] ?? ''] ?? null))

// Source editing (admins).
const editing = ref<EditableSource | 'new' | null>(null)
const pushToken = ref<{ id: string; token: string } | null>(null)
function editSource(i: number) {
  const s = sources.value.find(x => x.id === draft.sources[i])
  if (s && s.editable) { editing.value = s; tab.value = i; tested.value = null }
}
async function onSaved(s: EditableSource, template: SourceTemplate | null, token: string | null) {
  const isNew = editing.value === 'new'
  editing.value = null
  tested.value = null
  await loadSources()
  if (isNew) {
    draft.sources.push(s.id)
    tab.value = draft.sources.length - 1
    if (template && draft.sources.length === 1) Object.assign(draft, { ...template.widget, list: template.widget.list ? { ...template.widget.list } : draft.list })
  }
  if (token) pushToken.value = { id: s.id, token }
  setTimeout(() => { void loadSamples() }, 1500)
}
function onRemoved(id: string) {
  editing.value = null
  draft.sources = draft.sources.filter(x => x !== id)
  void loadSources()
}
const pushUrl = computed(() => pushToken.value ? `${location.origin}/api/widgets/push/${pushToken.value.id}` : '')
const curl = computed(() => pushToken.value ? `curl -X POST -H "Authorization: Bearer ${pushToken.value.token}" -H "Content-Type: application/json" -d '{"value": 42}' ${pushUrl.value}` : '')

// Picking a path from the tree into the focused field.
type Field = 'value' | 'caption' | 'list.path' | 'list.label' | 'list.value'
const focused = ref<Field>('value')
function read(f: Field): string { return f.startsWith('list.') ? draft.list![f.slice(5) as 'path' | 'label' | 'value'] : (draft[f as 'value' | 'caption'] ?? '') }
function write(f: Field, v: string) {
  if (f.startsWith('list.')) draft.list![f.slice(5) as 'path' | 'label' | 'value'] = v
  else draft[f as 'value' | 'caption'] = v
}
function pick(path: string) {
  const ref = `$${tab.value + 1}${path}`
  let insert = ref
  if (focused.value === 'list.label' || focused.value === 'list.value') {
    const base = draft.list!.path.trim()
    const m = base && ref.startsWith(base) ? /^\[\d+\](.*)$/.exec(ref.slice(base.length)) : null
    if (m) insert = `@${m[1]}`
  }
  const cur = read(focused.value).trim()
  write(focused.value, !cur || /^(\$[1-3]|@)[^\s+\-*/()]*$/.test(cur) ? insert : `${cur} ${insert}`)
}

const valueError = computed(() => checkExpression(draft.value))
const fid = (k: string) => `custom-${props.widget.id}-${k}`
const previewKey = computed(() => `${draft.sources.join(',')}:${draft.display}`)
const preview = computed<BoardWidget>(() => ({ ...props.widget, settings: { custom: compactCustom(draft) } }))

function save() {
  const custom = compactCustom({ ...draft, sources: draft.sources.filter(Boolean) })
  emit('save', { ...(title.value.trim() && { title: title.value.trim().slice(0, 60) }), custom })
}
</script>

<template>
  <Modal panel-class="w-full max-w-5xl" @close="emit('close')">
    <template #header>
      <h2 class="text-base font-semibold text-base-content">{{ editing ? (editing === 'new' ? t('widgets.source.new') : t('widgets.source.edit', { name: editing.name })) : t('widgets.custom.heading') }}</h2>
    </template>

    <div class="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <!-- Left: the source being edited, or the widget's settings -->
      <SourceForm
        v-if="editing" :key="editing === 'new' ? 'new' : editing.id" :source="editing === 'new' ? null : editing"
        @saved="onSaved" @removed="onRemoved" @tested="(v, e) => tested = { value: v, error: e }" @cancel="editing = null; tested = null"
      />
      <form v-else id="custom-widget" class="flex flex-col gap-5" @submit.prevent="save">
        <div v-if="pushToken" role="status" class="flex flex-col gap-2 rounded-box border border-info/40 bg-info/10 p-3 text-sm">
          <p class="font-medium text-base-content">{{ t('widgets.source.tokenOnce') }}</p>
          <div class="flex items-start gap-2">
            <code class="min-w-0 flex-1 break-all rounded-field bg-base-100 p-2 font-mono text-2xs">{{ curl }}</code>
            <Button variant="ghost" size="icon-sm" :aria-label="t('widgets.source.copy')" @click="copyText(curl)"><CopyIcon aria-hidden="true" /></Button>
          </div>
          <Button variant="ghost" size="xs" class="self-end" @click="pushToken = null">{{ t('widgets.source.tokenDone') }}</Button>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label :for="fid('title')">{{ t('widgets.settings.title.label') }}</Label>
          <input :id="fid('title')" v-model="title" class="input w-full" maxlength="60" :placeholder="t('widgets.types.custom.title')">
        </div>

        <fieldset class="flex flex-col gap-2">
          <legend class="mb-1 text-sm font-medium text-base-content">{{ t('widgets.custom.sources') }}</legend>
          <div v-for="(_, i) in draft.sources" :key="i" class="flex items-center gap-2">
            <span class="w-7 shrink-0 font-mono text-xs text-base-content/70">${{ i + 1 }}</span>
            <NativeSelect v-model="draft.sources[i]" class="flex-1" :aria-label="`$${i + 1}`">
              <NativeSelectOption v-for="s in sources" :key="s.id" :value="s.id">{{ s.name }}</NativeSelectOption>
            </NativeSelect>
            <Button v-if="isAdmin" variant="ghost" size="icon-sm" :aria-label="t('widgets.source.editShort')" :tooltip="t('widgets.source.editShort')" @click="editSource(i)"><PencilIcon aria-hidden="true" /></Button>
            <Button variant="ghost" size="icon-sm" :aria-label="t('widgets.custom.removeSource')" @click="draft.sources.splice(i, 1); tab = 0"><XIcon aria-hidden="true" /></Button>
          </div>
          <div class="flex flex-wrap gap-2">
            <NativeSelect v-if="draft.sources.length < 3 && sources.some(s => !draft.sources.includes(s.id))" :model-value="''" class="w-auto" :aria-label="t('widgets.custom.addSource')" @update:model-value="v => v && draft.sources.push(String(v))">
              <NativeSelectOption value="">{{ t('widgets.custom.addSource') }}</NativeSelectOption>
              <NativeSelectOption v-for="s in sources.filter(s => !draft.sources.includes(s.id))" :key="s.id" :value="s.id">{{ s.name }}</NativeSelectOption>
            </NativeSelect>
            <Button v-if="isAdmin && draft.sources.length < 3" variant="ghost" size="sm" @click="editing = 'new'; tested = null"><PlusIcon aria-hidden="true" />{{ t('widgets.source.new') }}</Button>
          </div>
          <p v-if="!sources.length" class="text-xs text-base-content/60">{{ isAdmin ? t('widgets.custom.noSourcesAdmin') : t('widgets.custom.noSources') }}</p>
        </fieldset>

        <div class="grid gap-4 sm:grid-cols-2">
          <div class="flex flex-col gap-1.5">
            <Label :for="fid('display')">{{ t('widgets.custom.display') }}</Label>
            <NativeSelect :id="fid('display')" v-model="draft.display">
              <NativeSelectOption v-for="d in DISPLAYS" :key="d" :value="d">{{ t(`widgets.custom.displays.${d}`) }}</NativeSelectOption>
            </NativeSelect>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label :for="fid('format')">{{ t('widgets.custom.format') }}</Label>
            <NativeSelect :id="fid('format')" v-model="draft.format">
              <NativeSelectOption v-for="f in FORMATS" :key="f" :value="f">{{ t(`widgets.custom.formats.${f}`) }}</NativeSelectOption>
            </NativeSelect>
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label :for="fid('value')">{{ t('widgets.custom.value') }}</Label>
          <input :id="fid('value')" v-model="draft.value" class="input w-full font-mono" :aria-invalid="!!valueError" @focus="focused = 'value'">
          <p :class="['text-xs', valueError ? 'text-error' : 'text-base-content/60']">{{ valueError ?? t('widgets.custom.valueHint') }}</p>
        </div>

        <div v-if="draft.display === 'list'" class="grid gap-3 rounded-box border border-base-300 p-3 sm:grid-cols-3">
          <div class="flex flex-col gap-1.5"><Label :for="fid('lpath')">{{ t('widgets.custom.listPath') }}</Label><input :id="fid('lpath')" v-model="draft.list!.path" class="input input-sm w-full font-mono" @focus="focused = 'list.path'"></div>
          <div class="flex flex-col gap-1.5"><Label :for="fid('llabel')">{{ t('widgets.custom.listLabel') }}</Label><input :id="fid('llabel')" v-model="draft.list!.label" class="input input-sm w-full font-mono" @focus="focused = 'list.label'"></div>
          <div class="flex flex-col gap-1.5"><Label :for="fid('lvalue')">{{ t('widgets.custom.listValue') }}</Label><input :id="fid('lvalue')" v-model="draft.list!.value" class="input input-sm w-full font-mono" @focus="focused = 'list.value'"></div>
          <div class="flex flex-col gap-1.5"><Label :for="fid('lformat')">{{ t('widgets.custom.listFormat') }}</Label>
            <NativeSelect :id="fid('lformat')" v-model="draft.list!.format" class="select-sm">
              <NativeSelectOption v-for="f in FORMATS" :key="f" :value="f">{{ t(`widgets.custom.formats.${f}`) }}</NativeSelectOption>
            </NativeSelect>
          </div>
          <p class="text-xs text-base-content/60 sm:col-span-2 sm:self-end">{{ t('widgets.custom.listHint') }}</p>
        </div>

        <div class="grid gap-4 sm:grid-cols-3">
          <div class="flex flex-col gap-1.5"><Label :for="fid('prefix')">{{ t('widgets.custom.prefix') }}</Label><input :id="fid('prefix')" v-model="draft.prefix" class="input input-sm w-full" maxlength="12"></div>
          <div class="flex flex-col gap-1.5"><Label :for="fid('unit')">{{ t('widgets.custom.unit') }}</Label><input :id="fid('unit')" v-model="draft.unit" class="input input-sm w-full" maxlength="12"></div>
          <div class="flex flex-col gap-1.5"><Label :for="fid('decimals')">{{ t('widgets.custom.decimals') }}</Label><input :id="fid('decimals')" v-model.number="draft.decimals" type="number" min="0" max="6" class="input input-sm w-full"></div>
        </div>
        <div class="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div class="flex flex-col gap-1.5"><Label :for="fid('caption')">{{ t('widgets.custom.caption') }}</Label><input :id="fid('caption')" v-model="draft.caption" class="input input-sm w-full font-mono" @focus="focused = 'caption'"></div>
          <div class="flex flex-col gap-1.5"><Label :for="fid('cformat')">{{ t('widgets.custom.captionFormat') }}</Label>
            <NativeSelect :id="fid('cformat')" v-model="draft.captionFormat" class="select-sm">
              <NativeSelectOption v-for="f in FORMATS" :key="f" :value="f">{{ t(`widgets.custom.formats.${f}`) }}</NativeSelectOption>
            </NativeSelect>
          </div>
        </div>

        <div class="grid gap-4 sm:grid-cols-4">
          <div class="flex flex-col gap-1.5"><Label :for="fid('warn')">{{ t('widgets.custom.warn') }}</Label><input :id="fid('warn')" v-model="draft.warn" class="input input-sm w-full" inputmode="decimal"></div>
          <div class="flex flex-col gap-1.5"><Label :for="fid('bad')">{{ t('widgets.custom.bad') }}</Label><input :id="fid('bad')" v-model="draft.bad" class="input input-sm w-full" inputmode="decimal"></div>
          <template v-if="draft.display === 'gauge'">
            <div class="flex flex-col gap-1.5"><Label :for="fid('min')">{{ t('widgets.custom.min') }}</Label><input :id="fid('min')" v-model="draft.min" class="input input-sm w-full" inputmode="decimal"></div>
            <div class="flex flex-col gap-1.5"><Label :for="fid('max')">{{ t('widgets.custom.max') }}</Label><input :id="fid('max')" v-model="draft.max" class="input input-sm w-full" inputmode="decimal"></div>
          </template>
          <template v-else-if="draft.display === 'status' || draft.format === 'bool'">
            <div class="flex flex-col gap-1.5"><Label :for="fid('yes')">{{ t('widgets.custom.yesWord') }}</Label><input :id="fid('yes')" v-model="draft.yes" class="input input-sm w-full" maxlength="30" :placeholder="t('widgets.custom.yes')"></div>
            <div class="flex flex-col gap-1.5"><Label :for="fid('no')">{{ t('widgets.custom.noWord') }}</Label><input :id="fid('no')" v-model="draft.no" class="input input-sm w-full" maxlength="30" :placeholder="t('widgets.custom.no')"></div>
          </template>
          <label class="flex items-center gap-2 text-sm sm:col-span-4"><input v-model="draft.below" type="checkbox" class="checkbox checkbox-sm">{{ t('widgets.custom.below') }}</label>
        </div>
      </form>

      <!-- Right: preview and data -->
      <aside class="flex min-w-0 flex-col gap-4">
        <section v-if="!editing" class="flex flex-col gap-2">
          <h3 class="eyebrow">{{ t('widgets.custom.preview') }}</h3>
          <div class="card min-h-40 border border-base-300 bg-base-100 p-4">
            <CustomWidget :key="previewKey" :widget="preview" size="m" :config="draft" />
          </div>
        </section>
        <section class="flex min-h-0 flex-col gap-2">
          <div class="flex items-center gap-2">
            <h3 class="eyebrow flex-1">{{ tested ? t('widgets.custom.testResult') : t('widgets.custom.data') }}</h3>
            <div v-if="!tested && draft.sources.length > 1" role="tablist" class="join">
              <button v-for="(id, i) in draft.sources" :key="id + i" role="tab" type="button" :aria-selected="tab === i" :class="['btn btn-xs join-item font-mono', tab === i ? 'btn-active' : 'btn-ghost']" @click="tab = i">${{ i + 1 }}</button>
            </div>
            <Button v-if="!tested" variant="ghost" size="icon-xs" :aria-label="t('widgets.custom.reload')" @click="loadSamples"><RefreshCwIcon class="size-3.5" aria-hidden="true" /></Button>
          </div>
          <p class="text-xs text-base-content/60">{{ t('widgets.custom.pickHint') }}</p>
          <div class="max-h-96 overflow-auto rounded-box border border-base-300 bg-base-200/60 p-2">
            <p v-if="shown?.error" class="status-text text-error"><span class="status-tag">[ERR]</span> {{ shown.error }}</p>
            <JsonTree v-else-if="shown && shown.value !== null && shown.value !== undefined" :value="shown.value" path="" @pick="pick" />
            <p v-else class="p-2 text-xs text-base-content/60">{{ t('widgets.custom.noData') }}</p>
          </div>
        </section>
      </aside>
    </div>

    <template v-if="!editing" #footer>
      <div class="flex w-full justify-end gap-2 px-5 py-4">
        <Button variant="ghost" @click="emit('close')">{{ t('widgets.settings.cancel') }}</Button>
        <Button type="submit" form="custom-widget" :disabled="!!valueError">{{ t('common.save') }}</Button>
      </div>
    </template>
  </Modal>
</template>
