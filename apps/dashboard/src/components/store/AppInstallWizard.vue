<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Card } from '@/components/ui/card'
import { ref, computed, onMounted, watch } from 'vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { focusNewApp } from '../../lib/app-focus'
import type { Place } from '../apps/VolumesTable.vue'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'
import { generateSecret, portCandidates } from './install-helpers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'

const { t } = useI18n()

type Manifest     = Awaited<ReturnType<typeof trpc.catalog.get.query>>
type InstallInput = Parameters<typeof trpc.catalog.install.mutate>[0]
type VolumesInput = NonNullable<InstallInput['volumes']>
type VolumeInput   = VolumesInput[number]

type VolMode = 'place' | 'newPlace' | 'bind' | 'named'

interface PortRow {
  container: number
  protocol:  'tcp' | 'udp'
  label:     string
  host:      number
}
interface EnvRow {
  key:      string
  label:    string
  secret:   boolean
  required: boolean
  value:    string
  shown:    boolean // a secret shown in clear, e.g. to note a generated token
}
interface VolumeRow {
  target:       string
  label:        string
  mode:         VolMode
  placeId:      string
  newPlaceName: string
  newPlacePath: string
  bindPath:     string
  namedName:    string
}

const props = defineProps<{ appId: string }>()
const emit  = defineEmits<{ installed: []; close: [] }>()

const manifest  = ref<Manifest | null>(null)
const loading   = ref(true)
const loadError = ref('')
const places    = ref<Place[]>([])

const name       = ref(props.appId)
const ports      = ref<PortRow[]>([])
const envRows    = ref<EnvRow[]>([])
const volumeRows = ref<VolumeRow[]>([])

const installing   = ref(false)
const installError = ref('')

/** Last path segment, used to derive default volume names/paths. */
function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

async function load() {
  loading.value  = true
  loadError.value = ''
  let m: Manifest
  try {
    m = await trpc.catalog.get.query({ id: props.appId })
  } catch (e: any) {
    loadError.value = e?.message ?? t('uis.store.AppInstallWizard.failedToLoadThisApp')
    loading.value = false
    return
  }
  manifest.value = m

  name.value = props.appId

  ports.value = m.ports.map((p) => ({
    container: p.container,
    protocol:  p.protocol,
    label:     p.label,
    host:      p.hostDefault ?? p.container,
  }))

  envRows.value = m.env
    .filter((e) => !!e.prompt)
    .map((e) => ({
      key:      e.key,
      label:    e.prompt ?? e.key,
      secret:   e.secret,
      required: e.required,
      value:    e.default ?? '',
      shown:    false,
    }))

  volumeRows.value = m.volumes.map((v) => {
    const base = basename(v.target)
    return {
      target:       v.target,
      label:        v.label,
      mode:         v.suggest,
      placeId:      '',
      newPlaceName: `${props.appId}-${base}`,
      newPlacePath: `/srv/apps/${props.appId}/${base}`,
      bindPath:     '',
      namedName:    `${name.value}_${base}`,
    }
  })

  loading.value = false

  try {
    places.value = await trpc.place.list.query() as Place[]
  } catch {
    // Non-fatal: the "existing place" volume mode will just show no options.
  }
}
onMounted(load)

// Lowercase only: Compose v2 lowercases project names (must match the
// backend's stack-name rules).
const nameValid = computed(() => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name.value))

const envValid = computed(() =>
  envRows.value.every((e) => !e.required || e.value.trim() !== '')
)

const portsValid = computed(() =>
  ports.value.every((p) => Number.isInteger(p.host) && p.host >= 1 && p.host <= 65535)
)

// Non-blocking "host port already in use" warnings, keyed by `${container}-${protocol}`,
// with a free port to switch to. A conflict never disables Install (Docker
// remains the authoritative failure).
const portWarnings = ref<Record<string, string>>({})
const portSuggestions = ref<Record<string, number>>({})
let portTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => ports.value.map((p) => `${p.container}/${p.protocol}=${p.host}`).join(','),
  () => {
    if (portTimer) clearTimeout(portTimer)
    portTimer = setTimeout(checkPorts, 400)
  },
)
async function checkPorts() {
  const next: Record<string, string> = {}
  const suggest: Record<string, number> = {}
  await Promise.all(ports.value.map(async (p) => {
    if (!Number.isInteger(p.host) || p.host < 1 || p.host > 65535) return
    const key = `${p.container}-${p.protocol}`
    try {
      const r = await trpc.container.app.checkPort.query({ port: p.host, protocol: p.protocol })
      if (!r.inUse) return
      next[key] = `Port ${p.host} is already used by ${r.by}.`
      // The next free port up, never one another row of this form uses.
      const taken = new Set(ports.value.filter(o => o !== p).map(o => o.host))
      for (const candidate of portCandidates(p.host, taken, 20)) {
        const c = await trpc.container.app.checkPort.query({ port: candidate, protocol: p.protocol })
        if (!c.inUse) { suggest[key] = candidate; break }
      }
    } catch { /* best-effort, ignore */ }
  }))
  portWarnings.value = next
  portSuggestions.value = suggest
}

function useSuggestedPort(p: PortRow) {
  const port = portSuggestions.value[`${p.container}-${p.protocol}`]
  if (port) p.host = port
}

function generate(e: EnvRow) {
  e.value = generateSecret()
  e.shown = true // so it can be noted: an admin token is needed to sign in
}

const volumesValid = computed(() =>
  volumeRows.value.every((v) => {
    if (v.mode === 'place')    return !!v.placeId
    if (v.mode === 'newPlace') return v.newPlaceName.trim() !== '' && v.newPlacePath.trim().startsWith('/')
    if (v.mode === 'bind')     return v.bindPath.trim().startsWith('/')
    return v.namedName.trim() !== '' // named
  })
)

const canInstall = computed(() =>
  !!manifest.value &&
  nameValid.value && envValid.value && portsValid.value && volumesValid.value &&
  !installing.value
)

async function install() {
  if (!manifest.value || !canInstall.value) return
  installError.value = ''
  installing.value = true
  try {
    const volumes: VolumesInput = volumeRows.value.map((v): VolumeInput => {
      switch (v.mode) {
        case 'place':    return { target: v.target, source: { kind: 'place',    placeId: v.placeId } }
        case 'newPlace': return { target: v.target, source: { kind: 'newPlace', name: v.newPlaceName.trim(), path: v.newPlacePath.trim() } }
        case 'bind':     return { target: v.target, source: { kind: 'bind',     path: v.bindPath.trim() } }
        case 'named':    return { target: v.target, source: { kind: 'named',   name: v.namedName.trim() } }
      }
    })

    const payload: InstallInput = {
      id:      props.appId,
      name:    name.value,
      ports:   ports.value.map((p) => ({ container: p.container, host: p.host })),
      env:     envRows.value.map((e) => ({ key: e.key, value: e.value })),
      volumes,
    }

    await applyPlanned('app.install', payload, {
      domain: 'apps', title: t('uis.store.AppInstallWizard.install', { p0: name.value }), actionLabel: t('uis.store.AppInstallWizard.install2'),
    })
    emit('installed')
    // Show the new app in Apps (its start-up logs) rather than opening it
    // before it is up.
    focusNewApp(name.value)
  } catch (e: any) {
    installError.value = e?.message ?? t('uis.store.AppInstallWizard.failedToInstallThisApp')
  } finally {
    installing.value = false
  }
}
</script>

<template>
  <Card class="block gap-0 py-0 overflow-hidden p-5 space-y-5">

    <LoadingState v-if="loading" variant="compact" />

    <div v-else-if="loadError"><ErrorState :message="loadError" /><div class="flex justify-center"><Button variant="outline" size="sm" @click="emit('close')">{{ t('ui.store.AppInstallWizard.back') }}</Button></div></div>

    <template v-else-if="manifest">
      <!-- Header -->
      <div class="flex items-center gap-3">
        <!-- eslint-disable-next-line vue/no-v-html -- `manifest.icon` is a bundled first-party brand logo from @app/app-catalog, not user input. -->
        <span class="w-10 h-10 shrink-0 grid place-items-center" v-html="manifest.icon" />
        <div class="min-w-0">
          <h3 class="text-sm font-semibold text-foreground">{{ manifest.name }}</h3>
          <p class="text-xs text-muted-foreground">{{ manifest.tagline }}</p>
        </div>
      </div>

      <!-- Name -->
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">{{ t('ui.store.AppInstallWizard.appName') }}</label>
        <Input v-model="name" maxlength="64" laceholder="app-name" />
        <p v-if="!nameValid" role="alert" class="status-text text-destructive">
          <span class="status-tag">[ERR]</span> {{ t('ui.store.AppInstallWizard.useLowercaseLettersNumbersOr') }}
        </p>
      </div>

      <!-- Ports -->
      <div v-if="ports.length" class="space-y-2">
        <h4 class="eyebrow">{{ t('ui.store.AppInstallWizard.ports') }}</h4>
        <div v-for="p in ports" :key="`${p.container}-${p.protocol}`" class="space-y-1">
          <div class="flex items-center gap-3">
            <span class="text-sm text-foreground flex-1">{{ p.label }}</span>
            <span class="text-xs text-muted-foreground font-mono shrink-0">{{ p.container }}/{{ p.protocol }}</span>
            <Input
              type="number" min="1" max="65535"
              v-model.number="p.host"
              class="w-28 shrink-0"
            />
          </div>
          <p v-if="portWarnings[`${p.container}-${p.protocol}`]" class="status-text text-warning">
            <span class="status-tag">[WARN]</span> {{ portWarnings[`${p.container}-${p.protocol}`] }}
            <Button variant="outline" size="xs" v-if="portSuggestions[`${p.container}-${p.protocol}`]" type="button" class="ml-1" @click="useSuggestedPort(p)">
              {{ t('uip.store.AppInstallWizard.usePort', { p0: portSuggestions[`${p.container}-${p.protocol}`] }) }}
            </Button>
          </p>
        </div>
      </div>

      <!-- Env -->
      <div v-if="envRows.length" class="space-y-3">
        <h4 class="eyebrow">{{ t('ui.store.AppInstallWizard.settings') }}</h4>
        <div v-for="e in envRows" :key="e.key" class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground uppercase tracking-caps">
            {{ e.label }}<span v-if="e.required" class="text-destructive"> *</span>
          </label>
          <div v-if="e.secret" class="flex gap-2">
            <Input
              :type="e.shown ? 'text' : 'password'"
              v-model="e.value"
              :placeholder="e.key"
              autocomplete="off"
              class="flex-1 min-w-0 font-mono"
            />
            <Button variant="outline" size="sm" type="button" class="shrink-0" @click="e.shown = !e.shown">{{ e.shown ? 'Hide' : 'Show' }}</Button>
            <Button variant="outline" size="sm" type="button" class="shrink-0" @click="generate(e)">{{ t('ui.store.AppInstallWizard.generate') }}</Button>
          </div>
          <Input
            v-else
            type="text"
            v-model="e.value"
            :placeholder="e.key"
          />
          <p v-if="e.secret && e.shown && e.value" class="text-2xs text-muted-foreground">{{ t('ui.store.AppInstallWizard.noteItSomewhereSafeBefore') }}</p>
        </div>
      </div>

      <!-- Volumes -->
      <div v-if="volumeRows.length" class="space-y-4">
        <h4 class="eyebrow">{{ t('ui.store.AppInstallWizard.storage') }}</h4>
        <div
          v-for="v in volumeRows" :key="v.target"
          class="space-y-2 pb-4 border-b border-border last:border-b-0 last:pb-0"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-foreground">{{ v.label }}</span>
            <span class="text-xs text-muted-foreground font-mono">{{ v.target }}</span>
          </div>

          <NativeSelect
            :model-value="v.mode"
            @change="v.mode = ($event.target as HTMLSelectElement).value as VolMode"
          >
            <NativeSelectOption value="place">{{ t('ui.store.AppInstallWizard.existingPlace') }}</NativeSelectOption>
            <NativeSelectOption value="newPlace">{{ t('ui.store.AppInstallWizard.newPlace') }}</NativeSelectOption>
            <NativeSelectOption value="bind">{{ t('ui.store.AppInstallWizard.hostPathBindMount') }}</NativeSelectOption>
            <NativeSelectOption value="named">{{ t('ui.store.AppInstallWizard.namedDockerVolume') }}</NativeSelectOption>
          </NativeSelect>

          <NativeSelect
            v-if="v.mode === 'place'"
            :model-value="v.placeId"
            @change="v.placeId = ($event.target as HTMLSelectElement).value"
          >
            <NativeSelectOption value="">{{ t('ui.store.AppInstallWizard.selectAPlace') }}</NativeSelectOption>
            <NativeSelectOption v-for="pl in places" :key="pl.id" :value="pl.id">{{ pl.name }} ({{ pl.path }})</NativeSelectOption>
          </NativeSelect>
          <p v-if="v.mode === 'place' && places.length === 0" class="text-xs text-muted-foreground">
            {{ t('ui.store.AppInstallWizard.noPlacesYetCreateOne') }}
          </p>

          <div v-else-if="v.mode === 'newPlace'" class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Input v-model="v.newPlaceName" :placeholder="t('ui.store.AppInstallWizard.placeName')" />
            <Input v-model="v.newPlacePath" laceholder="/srv/apps/…" class="font-mono" />
          </div>

          <Input v-else-if="v.mode === 'bind'" v-model="v.bindPath" laceholder="/host/path" class="font-mono" />

          <Input v-else-if="v.mode === 'named'" v-model="v.namedName" laceholder="volume-name" class="font-mono" />
        </div>
      </div>

      <!-- Footer -->
      <div class="flex items-center gap-3 pt-2 border-t border-border">
        <p v-if="installError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ installError }}</p>
        <div v-else class="flex-1" />
        <Button variant="outline" size="sm" @click="emit('close')">{{ t('ui.store.AppInstallWizard.cancel') }}</Button>
        <Button size="sm" :disabled="!canInstall" @click="install">
          {{ installing ? 'Installing…' : 'Install' }}
        </Button>
      </div>
    </template>

  </Card>
</template>
