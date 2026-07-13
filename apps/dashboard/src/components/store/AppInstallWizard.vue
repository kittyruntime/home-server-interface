<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import type { Place } from '../apps/VolumesTable.vue'

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

/** Last path segment — used to derive default volume names/paths. */
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
    loadError.value = e?.message ?? 'Failed to load this app'
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
    // Non-fatal — the "existing place" volume mode will just show no options.
  }
}
onMounted(load)

const nameValid = computed(() => /^[a-zA-Z0-9_-]+$/.test(name.value) && name.value.length <= 64)

const envValid = computed(() =>
  envRows.value.every((e) => !e.required || e.value.trim() !== '')
)

const portsValid = computed(() =>
  ports.value.every((p) => Number.isInteger(p.host) && p.host >= 1 && p.host <= 65535)
)

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

    const result = await trpc.catalog.install.mutate(payload)
    emit('installed')
    if (result.webPort != null) {
      window.open(`http://${location.hostname}:${result.webPort}`, '_blank')
    }
  } catch (e: any) {
    installError.value = e?.message ?? 'Failed to install this app'
  } finally {
    installing.value = false
  }
}
</script>

<template>
  <div class="panel-card p-5 space-y-5">

    <div v-if="loading" class="text-sm text-[var(--c-text-3)]">Loading…</div>

    <div v-else-if="loadError" class="space-y-3">
      <p class="text-sm text-[var(--c-danger)]">{{ loadError }}</p>
      <button class="btn btn-outline btn-sm" @click="emit('close')">Back</button>
    </div>

    <template v-else-if="manifest">
      <!-- Header -->
      <div class="flex items-center gap-3">
        <!-- eslint-disable-next-line vue/no-v-html -- `manifest.icon` is a bundled first-party SVG from @app/app-catalog, not user input. -->
        <span class="w-10 h-10 shrink-0 text-[var(--c-text-2)]" v-html="manifest.icon" />
        <div class="min-w-0">
          <h3 class="text-sm font-semibold text-[var(--c-text-1)]">{{ manifest.name }}</h3>
          <p class="text-xs text-[var(--c-text-3)]">{{ manifest.tagline }}</p>
        </div>
      </div>

      <!-- Name -->
      <div class="space-y-1.5">
        <label class="text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">App name</label>
        <input v-model="name" maxlength="64" placeholder="app-name" class="ui-input" />
        <p v-if="!nameValid" class="text-xs text-[var(--c-danger)]">
          Only letters, numbers, "_" and "-" are allowed.
        </p>
      </div>

      <!-- Ports -->
      <div v-if="ports.length" class="space-y-2">
        <h4 class="eyebrow">Ports</h4>
        <div v-for="p in ports" :key="`${p.container}-${p.protocol}`" class="flex items-center gap-3">
          <span class="text-sm text-[var(--c-text-1)] flex-1">{{ p.label }}</span>
          <span class="text-xs text-[var(--c-text-3)] font-mono shrink-0">{{ p.container }}/{{ p.protocol }}</span>
          <input
            type="number" min="1" max="65535"
            v-model.number="p.host"
            class="ui-input w-28 shrink-0"
          />
        </div>
      </div>

      <!-- Env -->
      <div v-if="envRows.length" class="space-y-3">
        <h4 class="eyebrow">Settings</h4>
        <div v-for="e in envRows" :key="e.key" class="space-y-1.5">
          <label class="text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">
            {{ e.label }}<span v-if="e.required" class="text-[var(--c-danger)]"> *</span>
          </label>
          <input
            :type="e.secret ? 'password' : 'text'"
            v-model="e.value"
            :placeholder="e.key"
            class="ui-input"
          />
        </div>
      </div>

      <!-- Volumes -->
      <div v-if="volumeRows.length" class="space-y-4">
        <h4 class="eyebrow">Storage</h4>
        <div
          v-for="v in volumeRows" :key="v.target"
          class="space-y-2 pb-4 border-b border-[var(--c-border)] last:border-b-0 last:pb-0"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-[var(--c-text-1)]">{{ v.label }}</span>
            <span class="text-xs text-[var(--c-text-3)] font-mono">{{ v.target }}</span>
          </div>

          <select
            :value="v.mode"
            @change="v.mode = ($event.target as HTMLSelectElement).value as VolMode"
            class="ui-input"
          >
            <option value="place">Existing place</option>
            <option value="newPlace">New place</option>
            <option value="bind">Host path (bind mount)</option>
            <option value="named">Named Docker volume</option>
          </select>

          <select
            v-if="v.mode === 'place'"
            :value="v.placeId"
            @change="v.placeId = ($event.target as HTMLSelectElement).value"
            class="ui-input"
          >
            <option value="">— select a place —</option>
            <option v-for="pl in places" :key="pl.id" :value="pl.id">{{ pl.name }} ({{ pl.path }})</option>
          </select>
          <p v-if="v.mode === 'place' && places.length === 0" class="text-xs text-[var(--c-text-3)]">
            No places yet — create one from the Places page, or pick another source.
          </p>

          <div v-else-if="v.mode === 'newPlace'" class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input v-model="v.newPlaceName" placeholder="Place name" class="ui-input" />
            <input v-model="v.newPlacePath" placeholder="/srv/apps/…" class="ui-input font-mono" />
          </div>

          <input v-else-if="v.mode === 'bind'" v-model="v.bindPath" placeholder="/host/path" class="ui-input font-mono" />

          <input v-else-if="v.mode === 'named'" v-model="v.namedName" placeholder="volume-name" class="ui-input font-mono" />
        </div>
      </div>

      <!-- Footer -->
      <div class="flex items-center gap-3 pt-2 border-t border-[var(--c-border)]">
        <p v-if="installError" class="text-sm text-[var(--c-danger)] flex-1">{{ installError }}</p>
        <div v-else class="flex-1" />
        <button class="btn btn-outline btn-sm" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="!canInstall" @click="install">
          {{ installing ? 'Installing…' : 'Install' }}
        </button>
      </div>
    </template>

  </div>
</template>
