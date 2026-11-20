<script setup lang="ts">
import { reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { PlusIcon, Trash2Icon } from '@lucide/vue'
import Modal from '../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { typeKey, type WidgetDef } from './registry'
import { parseLinks } from './links'
import type { BoardWidget } from '../../lib/dashboard-boards'

// A widget's settings: its title, then what its type offers (a metric, a
// period, a note, links).

const props = defineProps<{ widget: BoardWidget; def: WidgetDef }>()
const emit = defineEmits<{ close: []; save: [settings: Record<string, unknown> | undefined] }>()
const { t } = useI18n()

const s = props.widget.settings ?? {}
const form = reactive({
  title: typeof s.title === 'string' ? s.title : '',
  values: Object.fromEntries((props.def.settings ?? []).filter(f => f.kind !== 'links').map(f => [f.key, typeof s[f.key] === 'string' ? s[f.key] as string : f.kind === 'select' ? f.options[0]! : ''])) as Record<string, string>,
  links: parseLinks(s.links).map(l => ({ ...l })),
})
if (!form.links.length && props.def.settings?.some(f => f.kind === 'links')) form.links.push({ label: '', url: '' })

const fieldId = (k: string) => `widget-${props.widget.id}-${k}`

function save() {
  const out: Record<string, unknown> = {}
  if (form.title.trim()) out.title = form.title.trim().slice(0, 60)
  for (const [k, v] of Object.entries(form.values)) if (v !== '') out[k] = k === 'text' ? v.slice(0, 3000) : v
  if (props.def.settings?.some(f => f.kind === 'links')) {
    const links = parseLinks(form.links.map(l => ({ label: l.label, url: /^[a-z]+:\/\//i.test(l.url.trim()) ? l.url.trim() : l.url.trim() ? `http://${l.url.trim()}` : '' })))
    if (links.length) out.links = links
  }
  emit('save', Object.keys(out).length ? out : undefined)
}
</script>

<template>
  <Modal panel-class="w-full max-w-lg" @close="emit('close')">
    <template #header>
      <h2 class="text-base font-semibold text-base-content">{{ t('widgets.settings.heading', { name: t(`widgets.types.${typeKey(def.type)}.title`) }) }}</h2>
    </template>
    <form id="widget-settings" class="flex flex-col gap-5 p-5" @submit.prevent="save">
      <div class="flex flex-col gap-1.5">
        <Label :for="fieldId('title')">{{ t('widgets.settings.title.label') }}</Label>
        <Input :id="fieldId('title')" v-model="form.title" maxlength="60" :placeholder="t(`widgets.types.${typeKey(def.type)}.title`)" />
      </div>

      <template v-for="f in def.settings ?? []" :key="f.key">
        <div v-if="f.kind === 'select'" class="flex flex-col gap-1.5">
          <Label :for="fieldId(f.key)">{{ t(`widgets.settings.${f.key}.label`) }}</Label>
          <NativeSelect :id="fieldId(f.key)" v-model="form.values[f.key]">
            <NativeSelectOption v-for="o in f.options" :key="o" :value="o">{{ t(`widgets.settings.${f.key}.options.${o}`) }}</NativeSelectOption>
          </NativeSelect>
        </div>
        <div v-else-if="f.kind === 'text'" class="flex flex-col gap-1.5">
          <Label :for="fieldId(f.key)">{{ t(`widgets.settings.${f.key}.label`) }}</Label>
          <Input :id="fieldId(f.key)" v-model="form.values[f.key]" />
        </div>
        <div v-else-if="f.kind === 'textarea'" class="flex flex-col gap-1.5">
          <Label :for="fieldId(f.key)">{{ t(`widgets.settings.${f.key}.label`) }}</Label>
          <Textarea :id="fieldId(f.key)" v-model="form.values[f.key]" rows="8" maxlength="3000" />
          <p class="text-xs text-base-content/60">{{ t(`widgets.settings.${f.key}.hint`) }}</p>
        </div>
        <fieldset v-else-if="f.kind === 'links'" class="flex flex-col gap-2">
          <legend class="mb-1.5 text-sm font-medium text-base-content">{{ t('widgets.settings.links.label') }}</legend>
          <div v-for="(link, idx) in form.links" :key="idx" class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2">
            <input v-model="link.label" class="input w-full" :aria-label="t('widgets.settings.links.name')" :placeholder="t('widgets.settings.links.name')" maxlength="60">
            <input v-model="link.url" class="input w-full font-mono" :aria-label="t('widgets.settings.links.url')" placeholder="http://192.168.1.10:8096" inputmode="url">
            <Button variant="ghost" size="icon-sm" :aria-label="t('widgets.settings.links.remove')" @click="form.links.splice(idx, 1)"><Trash2Icon aria-hidden="true" /></Button>
          </div>
          <Button v-if="form.links.length < 24" variant="ghost" size="sm" class="self-start" @click="form.links.push({ label: '', url: '' })">
            <PlusIcon aria-hidden="true" />{{ t('widgets.settings.links.add') }}
          </Button>
          <p class="text-xs text-base-content/60">{{ t('widgets.settings.links.hint') }}</p>
        </fieldset>
      </template>
    </form>
    <template #footer>
      <div class="flex w-full justify-end gap-2 px-5 py-4">
        <Button variant="ghost" @click="emit('close')">{{ t('widgets.settings.cancel') }}</Button>
        <Button type="submit" form="widget-settings">{{ t('common.save') }}</Button>
      </div>
    </template>
  </Modal>
</template>
