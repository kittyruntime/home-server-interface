<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PlusIcon, Trash2Icon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { trpc } from '../../lib/trpc'
import { useSource } from '../../lib/widget-data'
import { useConfirm } from '../../lib/confirm'
import { TEMPLATES, templateUrl, type SourceTemplate } from '../../lib/widget-templates'
import type { EditableSource } from './source-types'
import { typeKey } from './registry'

// An admin's data source: where HSI reads it (an address, a script that sends
// it, or a server command), how often, who may see it, a value to keep as a
// history and a rule that raises an alert.


const props = defineProps<{ source?: EditableSource | null }>()
const emit = defineEmits<{
  saved: [source: EditableSource, template: SourceTemplate | null, token: string | null]
  removed: [id: string]
  tested: [value: unknown, error: string | null]
  cancel: []
}>()
const { t } = useI18n()
const { confirm } = useConfirm()
const commands = useSource('widget-commands', () => trpc.widgetSource.commands.query(), 3_600_000)
const apps = useSource('apps', () => trpc.container.app.list.query(), 30_000)

const s = props.source
const form = reactive({
  name: s?.name ?? '',
  kind: (s?.kind ?? 'http') as 'http' | 'push' | 'command',
  url: s?.url ?? 'http://127.0.0.1:',
  headers: (s?.headers ?? []).map(h => ({ ...h })),
  command: s?.command ?? '',
  intervalSec: s?.intervalSec ?? 60,
  visibility: (s?.visibility ?? 'admins') as 'admins' | 'everyone',
  trackPath: s?.trackPath ?? '',
  allowSelfSigned: s?.allowSelfSigned ?? false,
  alertOn: !!s?.alert,
  alert: { path: '', op: 'gt', value: '', severity: 'warning', message: '', ...(s?.alert ?? {}) } as { path: string; op: 'gt' | 'lt' | 'eq' | 'ne'; value: string; severity: 'warning' | 'critical'; message: string },
})
const template = ref<SourceTemplate | null>(null)
const busy = ref<'save' | 'test' | null>(null)
const error = ref<string | null>(null)
const fid = (k: string) => `source-${s?.id ?? 'new'}-${k}`

const installed = (tp: SourceTemplate) => (apps.data.value ?? []).find(a => tp.apps?.includes(a.name.toLowerCase()))
function applyTemplate(id: string) {
  const tp = TEMPLATES.find(x => x.id === id) ?? null
  template.value = tp
  if (!tp) return
  form.name = t(`widgets.templates.${tp.id}.name`)
  form.kind = tp.kind
  form.intervalSec = tp.intervalSec
  form.trackPath = tp.trackPath ?? ''
  if (tp.kind === 'command') form.command = tp.command ?? ''
  else {
    form.url = templateUrl(tp, installed(tp)?.app?.ports?.[0]?.hostPort)
    form.headers = tp.header ? [{ name: tp.header.name, value: tp.header.prefix ?? '', secret: true }] : []
  }
}

const payload = computed(() => ({
  name: form.name.trim(), kind: form.kind, url: form.url.trim(), command: form.command,
  headers: form.headers.filter(h => h.name.trim()).map(h => ({ name: h.name.trim(), value: h.value, secret: h.secret })),
  intervalSec: Math.max(30, Math.round(Number(form.intervalSec) || 60)), visibility: form.visibility,
  trackPath: form.trackPath.trim(), allowSelfSigned: form.allowSelfSigned,
  alert: form.alertOn ? { ...form.alert, path: form.alert.path.trim() } : null,
}))

async function test() {
  busy.value = 'test'; error.value = null
  try {
    const r = await trpc.widgetSource.test.mutate({ id: s?.id, source: payload.value })
    emit('tested', r.ok ? r.value : null, r.ok ? null : r.error)
  } catch (e) { error.value = (e as Error).message } finally { busy.value = null }
}

async function save() {
  busy.value = 'save'; error.value = null
  try {
    const r = s ? await trpc.widgetSource.update.mutate({ id: s.id, source: payload.value }) : await trpc.widgetSource.create.mutate(payload.value)
    emit('saved', { ...r.source, editable: true } as EditableSource, template.value, r.token)
  } catch (e) { error.value = (e as Error).message } finally { busy.value = null }
}

async function remove() {
  if (!s) return
  if (!await confirm(t('widgets.source.removeConfirm', { name: s.name }), { title: t('widgets.source.remove'), confirmLabel: t('widgets.source.remove'), danger: true })) return
  await trpc.widgetSource.remove.mutate({ id: s.id })
  emit('removed', s.id)
}
</script>

<template>
  <form class="flex flex-col gap-4" @submit.prevent="save">
    <div v-if="!s" class="flex flex-col gap-1.5">
      <Label :for="fid('template')">{{ t('widgets.source.template') }}</Label>
      <NativeSelect :id="fid('template')" :model-value="template?.id ?? ''" @update:model-value="v => applyTemplate(String(v))">
        <NativeSelectOption value="">{{ t('widgets.source.noTemplate') }}</NativeSelectOption>
        <NativeSelectOption v-for="tp in TEMPLATES" :key="tp.id" :value="tp.id">
          {{ t(`widgets.templates.${tp.id}.name`) }}{{ installed(tp) ? ` (${t('widgets.source.installed')})` : '' }}
        </NativeSelectOption>
      </NativeSelect>
      <p v-if="template" class="text-xs text-base-content/70">{{ t(`widgets.templates.${template.id}.hint`) }}</p>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <div class="flex flex-col gap-1.5">
        <Label :for="fid('name')">{{ t('widgets.source.name') }}</Label>
        <input :id="fid('name')" v-model="form.name" class="input w-full" maxlength="60" required>
      </div>
      <div class="flex flex-col gap-1.5">
        <Label :for="fid('kind')">{{ t('widgets.source.kind') }}</Label>
        <NativeSelect :id="fid('kind')" v-model="form.kind">
          <NativeSelectOption v-for="k in ['http', 'push', 'command']" :key="k" :value="k">{{ t(`widgets.source.kinds.${k}`) }}</NativeSelectOption>
        </NativeSelect>
      </div>
    </div>

    <template v-if="form.kind === 'http'">
      <div class="flex flex-col gap-1.5">
        <Label :for="fid('url')">{{ t('widgets.source.url') }}</Label>
        <input :id="fid('url')" v-model="form.url" class="input w-full font-mono" inputmode="url" required>
        <p class="text-xs text-base-content/60">{{ t('widgets.source.urlHint') }}</p>
      </div>
      <label v-if="form.url.startsWith('https:')" class="flex items-start gap-2 text-sm">
        <input v-model="form.allowSelfSigned" type="checkbox" class="checkbox checkbox-sm mt-0.5">
        <span>{{ t('widgets.source.selfSigned') }}<span class="block text-xs text-base-content/60">{{ t('widgets.source.selfSignedHint') }}</span></span>
      </label>
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-1 text-sm font-medium text-base-content">{{ t('widgets.source.headers') }}</legend>
        <div v-for="(h, i) in form.headers" :key="i" class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto_auto] items-center gap-2">
          <input v-model="h.name" class="input input-sm w-full font-mono" :aria-label="t('widgets.source.headerName')" :placeholder="t('widgets.source.headerName')">
          <input v-model="h.value" :type="h.secret ? 'password' : 'text'" autocomplete="off" class="input input-sm w-full font-mono" :aria-label="t('widgets.source.headerValue')" :placeholder="h.secret && s ? t('widgets.source.secretKept') : t('widgets.source.headerValue')">
          <label class="flex items-center gap-1 text-xs"><input v-model="h.secret" type="checkbox" class="checkbox checkbox-xs">{{ t('widgets.source.secret') }}</label>
          <Button variant="ghost" size="icon-sm" :aria-label="t('widgets.source.removeHeader')" @click="form.headers.splice(i, 1)"><Trash2Icon aria-hidden="true" /></Button>
        </div>
        <Button v-if="form.headers.length < 12" variant="ghost" size="sm" class="self-start" @click="form.headers.push({ name: '', value: '', secret: true })"><PlusIcon aria-hidden="true" />{{ t('widgets.source.addHeader') }}</Button>
        <p class="text-xs text-base-content/60">{{ t('widgets.source.secretHint') }}</p>
      </fieldset>
    </template>
    <div v-else-if="form.kind === 'command'" class="flex flex-col gap-1.5">
      <Label :for="fid('command')">{{ t('widgets.source.command') }}</Label>
      <NativeSelect :id="fid('command')" v-model="form.command">
        <NativeSelectOption value="" disabled>{{ t('widgets.source.pickCommand') }}</NativeSelectOption>
        <NativeSelectOption v-for="c in commands.data.value ?? []" :key="c" :value="c">{{ t(`widgets.commands.${typeKey(c)}`) }}</NativeSelectOption>
      </NativeSelect>
      <p class="text-xs text-base-content/60">{{ t('widgets.source.commandHint') }}</p>
    </div>
    <p v-else class="text-sm text-base-content/70">{{ t('widgets.source.pushHint') }}</p>

    <div class="grid gap-4 sm:grid-cols-3">
      <div v-if="form.kind !== 'push'" class="flex flex-col gap-1.5">
        <Label :for="fid('interval')">{{ t('widgets.source.interval') }}</Label>
        <input :id="fid('interval')" v-model.number="form.intervalSec" type="number" min="30" max="86400" class="input w-full tabular-nums">
      </div>
      <div class="flex flex-col gap-1.5">
        <Label :for="fid('visibility')">{{ t('widgets.source.visibility') }}</Label>
        <NativeSelect :id="fid('visibility')" v-model="form.visibility">
          <NativeSelectOption value="admins">{{ t('widgets.source.visibilities.admins') }}</NativeSelectOption>
          <NativeSelectOption value="everyone">{{ t('widgets.source.visibilities.everyone') }}</NativeSelectOption>
        </NativeSelect>
      </div>
      <div class="flex flex-col gap-1.5">
        <Label :for="fid('track')">{{ t('widgets.source.track') }}</Label>
        <input :id="fid('track')" v-model="form.trackPath" class="input w-full font-mono" :placeholder="t('widgets.source.trackPlaceholder')">
      </div>
    </div>

    <fieldset class="flex flex-col gap-2 rounded-box border border-base-300 p-3">
      <label class="flex items-center gap-2 text-sm font-medium"><input v-model="form.alertOn" type="checkbox" class="checkbox checkbox-sm">{{ t('widgets.source.alert') }}</label>
      <template v-if="form.alertOn">
        <div class="grid grid-cols-[minmax(0,2fr)_auto_minmax(0,1fr)_auto] items-center gap-2">
          <input v-model="form.alert.path" class="input input-sm w-full font-mono" :aria-label="t('widgets.source.alertPath')" :placeholder="t('widgets.source.alertPath')">
          <NativeSelect v-model="form.alert.op" class="select-sm" :aria-label="t('widgets.source.alertOp')">
            <NativeSelectOption v-for="op in ['gt', 'lt', 'eq', 'ne']" :key="op" :value="op">{{ t(`widgets.source.ops.${op}`) }}</NativeSelectOption>
          </NativeSelect>
          <input v-model="form.alert.value" class="input input-sm w-full" :aria-label="t('widgets.source.alertValue')" :placeholder="t('widgets.source.alertValue')">
          <NativeSelect v-model="form.alert.severity" class="select-sm" :aria-label="t('widgets.source.alertSeverity')">
            <NativeSelectOption value="warning">{{ t('widgets.source.severity.warning') }}</NativeSelectOption>
            <NativeSelectOption value="critical">{{ t('widgets.source.severity.critical') }}</NativeSelectOption>
          </NativeSelect>
        </div>
        <input v-model="form.alert.message" class="input input-sm w-full" maxlength="200" :aria-label="t('widgets.source.alertMessage')" :placeholder="t('widgets.source.alertMessage')">
        <p class="text-xs text-base-content/60">{{ t('widgets.source.alertHint') }}</p>
      </template>
    </fieldset>

    <p v-if="error" class="status-text text-error"><span class="status-tag">[ERR]</span> {{ error }}</p>
    <div class="flex flex-wrap items-center gap-2">
      <Button v-if="s" variant="ghost" class="text-error" @click="remove"><Trash2Icon aria-hidden="true" />{{ t('widgets.source.remove') }}</Button>
      <span class="flex-1" />
      <Button variant="ghost" @click="emit('cancel')">{{ t('widgets.settings.cancel') }}</Button>
      <Button v-if="form.kind !== 'push'" variant="outline" :disabled="busy !== null" @click="test">{{ busy === 'test' ? t('widgets.source.testing') : t('widgets.source.test') }}</Button>
      <Button type="submit" :disabled="busy !== null || !form.name.trim()">{{ t('widgets.source.save') }}</Button>
    </div>
  </form>
</template>
