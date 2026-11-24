<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, ref, shallowRef, watch } from 'vue'
import { BoxIcon, ChevronRightIcon, FileCodeIcon, StoreIcon } from '@lucide/vue'
import Modal from '../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { trpc } from '../../lib/trpc'

// The one way to add an app by hand. It asks what to add: a single app,
// set up in the form, or several services from a Compose file (an app with
// its database, cache...). The App Store stays one click away.
const emit = defineEmits<{
  close: []
  single: []
  store: []
  created: [name: string, start: boolean]
}>()

const { t } = useI18n()
const modal = ref<InstanceType<typeof Modal> | null>(null)
const step = ref<'choose' | 'compose'>('choose')

// The choices go through the dialog's leave animation before the parent acts.
let after: (() => void) | null = null
function leaveThen(fn: () => void) {
  after = fn
  modal.value?.requestClose()
}
function onClosed() {
  const fn = after
  after = null
  emit('close')
  fn?.()
}

// ── Compose ──────────────────────────────────────────────────────────────────
const name = ref('')
const content = ref('')
const error = ref('')
const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

// The YAML parser loads once something is pasted, for the service list.
const parse = shallowRef<typeof import('yaml')['parse'] | null>(null)
watch(content, v => { if (v.trim() && !parse.value) void import('yaml').then(m => { parse.value = m.parse }) })

const services = computed<string[] | null>(() => {
  if (!content.value.trim() || !parse.value) return null
  try {
    const doc = parse.value(content.value) as { services?: Record<string, unknown> } | null
    return doc?.services && typeof doc.services === 'object' ? Object.keys(doc.services) : []
  } catch { return [] }
})

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const nameValid = computed(() => NAME_RE.test(name.value.trim()))
const canAdd = computed(() => nameValid.value && !!services.value?.length && !busy.value)

function slug(s: string): string {
  return s.toLowerCase().replace(/\.ya?ml$/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64)
}

async function readFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  content.value = await file.text()
  if (!name.value) name.value = slug(file.name)
}

async function add(start: boolean) {
  error.value = ''
  busy.value = true
  try {
    const created = name.value.trim()
    await trpc.container.app.importCompose.mutate({ name: created, content: content.value })
    leaveThen(() => emit('created', created, start))
  } catch (e) {
    error.value = (e as Error)?.message || t('ui.apps.NewAppDialog.addFailed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal ref="modal" panel-class="w-full max-w-lg" @close="onClosed">
    <template #header>
      <h3 class="text-sm font-semibold text-base-content">
        {{ step === 'choose' ? t('ui.apps.NewAppDialog.title') : t('ui.apps.NewAppDialog.composeTitle') }}
      </h3>
    </template>

    <!-- What to add -->
    <div v-if="step === 'choose'" class="p-4 sm:p-5">
      <ul class="overflow-hidden rounded-box border border-base-300">
        <li>
          <button type="button" class="choice" @click="leaveThen(() => emit('single'))">
            <span class="choice__icon"><BoxIcon aria-hidden="true" /></span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold text-base-content">{{ t('ui.apps.NewAppDialog.single') }}</span>
              <span class="mt-0.5 block text-xs text-base-content/70">{{ t('ui.apps.NewAppDialog.singleHint') }}</span>
            </span>
            <ChevronRightIcon class="size-4 shrink-0 text-base-content/50" aria-hidden="true" />
          </button>
        </li>
        <li class="border-t border-base-300">
          <button type="button" class="choice" @click="step = 'compose'">
            <span class="choice__icon"><FileCodeIcon aria-hidden="true" /></span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold text-base-content">{{ t('ui.apps.NewAppDialog.compose') }}</span>
              <span class="mt-0.5 block text-xs text-base-content/70">{{ t('ui.apps.NewAppDialog.composeHint') }}</span>
            </span>
            <ChevronRightIcon class="size-4 shrink-0 text-base-content/50" aria-hidden="true" />
          </button>
        </li>
      </ul>
      <p class="mt-4 flex flex-wrap items-center gap-x-1.5 text-xs text-base-content/70">
        <StoreIcon class="size-3.5" aria-hidden="true" />
        {{ t('ui.apps.NewAppDialog.lookingForAnApp') }}
        <Button variant="link" class="h-auto p-0 text-xs" @click="leaveThen(() => emit('store'))">{{ t('ui.apps.NewAppDialog.browseTheStore') }}</Button>
      </p>
    </div>

    <!-- Several services from a Compose file -->
    <form v-else class="grid gap-4 p-4 sm:p-5" @submit.prevent="add(true)">
      <div class="grid gap-1.5">
        <Label for="new-app-name" class="text-xs">{{ t('ui.apps.NewAppDialog.name') }}</Label>
        <Input id="new-app-name" v-model="name" autofocus maxlength="64" spellcheck="false" autocomplete="off"
          :placeholder="t('ui.apps.NewAppDialog.namePlaceholder')" :aria-invalid="!!name && !nameValid" />
        <p v-if="name && !nameValid" class="text-2xs text-error">{{ t('ui.apps.NewAppDialog.nameRule') }}</p>
      </div>
      <div class="grid gap-1.5">
        <div class="flex items-end justify-between gap-2">
          <Label for="new-app-compose" class="text-xs">compose.yaml</Label>
          <input ref="fileInput" type="file" accept=".yml,.yaml,text/yaml" class="hidden" @change="readFile">
          <Button type="button" variant="ghost" size="xs" @click="fileInput?.click()">{{ t('ui.apps.NewAppDialog.chooseFile') }}</Button>
        </div>
        <Textarea id="new-app-compose" v-model="content" rows="10" spellcheck="false"
          class="font-mono text-xs" :placeholder="t('ui.apps.NewAppDialog.composePlaceholder')" />
        <p v-if="services === null" class="text-2xs text-base-content/70">{{ t('ui.apps.NewAppDialog.composeHelp') }}</p>
        <p v-else-if="services.length" class="flex flex-wrap items-center gap-1.5 text-2xs text-base-content/70">
          {{ t('ui.apps.NewAppDialog.services', { n: services.length }, services.length) }}
          <span v-for="s in services" :key="s" class="rounded-field bg-base-200 px-1.5 py-0.5 font-mono text-base-content/80">{{ s }}</span>
        </p>
        <p v-else class="text-2xs text-error">{{ t('ui.apps.NewAppDialog.noServices') }}</p>
      </div>
      <Alert v-if="error" variant="destructive" role="alert"><AlertDescription>{{ error }}</AlertDescription></Alert>
    </form>

    <template v-if="step === 'compose'" #footer>
      <Button variant="ghost" size="sm" :disabled="busy" @click="step = 'choose'">{{ t('ui.apps.NewAppDialog.back') }}</Button>
      <div class="flex-1" />
      <Button variant="ghost" size="sm" :disabled="!canAdd" @click="add(false)">{{ t('ui.apps.NewAppDialog.addOnly') }}</Button>
      <Button size="sm" :disabled="!canAdd" @click="add(true)">{{ t('ui.apps.NewAppDialog.addAndStart') }}</Button>
    </template>
  </Modal>
</template>

<style scoped>
.choice {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.875rem;
  padding: 0.875rem 1rem;
  text-align: left;
  transition: background-color var(--dur-base) var(--ease-out);
}
.choice:hover,
.choice:focus-visible {
  background: var(--color-base-200);
  outline: none;
}
.choice__icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 23%;
  background: var(--color-base-200);
  color: var(--color-base-content);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--color-base-content) 9%, transparent);
}
.choice:hover .choice__icon { background: var(--color-base-100); }
.choice__icon :deep(svg) { width: 1.25rem; height: 1.25rem; }
</style>
