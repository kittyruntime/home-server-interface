<script setup lang="ts">
import { ref, reactive, watch, computed, onMounted } from 'vue'
import { parse as parseYaml } from 'yaml'
import { trpc } from '../../lib/trpc'
import PortsTable,      { type PortMapping }    from './PortsTable.vue'
import EnvsEditor,      { type EnvVar }         from './EnvsEditor.vue'
import VolumesTable,    { type VolumeMount, type Place } from './VolumesTable.vue'
import LabelsTable,     { type LabelEntry }     from './LabelsTable.vue'
import AdvancedSection, { type AdvancedConfig } from './AdvancedSection.vue'

type App = {
  id: string; name: string; image: string
  ports: PortMapping[]; envs: EnvVar[]; volumes: VolumeMount[]
  networkNames: string[]; labels: LabelEntry[]
  capAdd: string[]; capDrop: string[]; extraHosts: string[]
  restartPolicy: string
  hostname: string | null; user: string | null; command: string | null
  cpuLimit: number | null; memoryLimit: string | null
  pinnedUrl: string | null
  status: string
}

const props = defineProps<{ editApp?: App | null }>()
const emit  = defineEmits<{
  close: []
  saved: [app: App]
}>()

type Tab = 'basic' | 'ports' | 'envs' | 'volumes' | 'networks' | 'labels' | 'advanced'
const tabs: { id: Tab; label: string }[] = [
  { id: 'basic',    label: 'Basic' },
  { id: 'ports',    label: 'Ports' },
  { id: 'envs',     label: 'Envs' },
  { id: 'volumes',  label: 'Volumes' },
  { id: 'networks', label: 'Networks' },
  { id: 'labels',   label: 'Labels' },
  { id: 'advanced', label: 'Advanced' },
]
const activeTab   = ref<Tab>('basic')
const showCompose = ref(false)

function emptyForm() {
  return {
    name:          '',
    image:         '',
    ports:         [] as PortMapping[],
    envs:          [] as EnvVar[],
    volumes:       [] as VolumeMount[],
    networkNames:  [] as string[],
    labels:        [] as LabelEntry[],
    capAdd:        [] as string[],
    capDrop:       [] as string[],
    extraHosts:    [] as string[],
    restartPolicy: 'no',
    hostname:      null as string | null,
    user:          null as string | null,
    command:       null as string | null,
    cpuLimit:      null as number | null,
    memoryLimit:   null as string | null,
    pinnedUrl:     null as string | null,
  }
}

const form    = reactive(emptyForm())
const loading = ref(false)
const error   = ref('')

const places      = ref<Place[]>([])
const networkInput = ref('')

// ── Compose tab state ──────────────────────────────────────────────────────────
const composeRaw             = ref('')
const composeError           = ref('')
const composeSelectedService = ref('')

const composeServices = computed<string[]>(() => {
  if (!composeRaw.value.trim()) return []
  try {
    const doc = parseYaml(composeRaw.value) as any
    return Object.keys(doc?.services ?? {})
  } catch { return [] }
})

watch(composeServices, svcs => {
  if (svcs.length && !svcs.includes(composeSelectedService.value))
    composeSelectedService.value = svcs[0] ?? ''
})

function importCompose() {
  composeError.value = ''
  if (!composeRaw.value.trim()) { composeError.value = 'Paste a compose.yml first.'; return }
  let doc: any
  try { doc = parseYaml(composeRaw.value) } catch (e: any) { composeError.value = `YAML parse error: ${e.message}`; return }
  const services = doc?.services
  if (!services || typeof services !== 'object') { composeError.value = 'No services found.'; return }
  const svc = services[composeSelectedService.value]
  if (!svc) { composeError.value = `Service "${composeSelectedService.value}" not found.`; return }

  if (svc.image) form.image = svc.image

  if (Array.isArray(svc.ports)) {
    const parsed: PortMapping[] = []
    for (const p of svc.ports) {
      if (typeof p === 'string') {
        const m = p.match(/^(\d+):(\d+)(?:\/(tcp|udp))?$/)
        if (m) parsed.push({ hostPort: parseInt(m[1]!), containerPort: parseInt(m[2]!), protocol: (m[3] as 'tcp'|'udp') ?? 'tcp' })
      } else if (typeof p === 'object' && p.published != null && p.target != null) {
        parsed.push({ hostPort: Number(p.published), containerPort: Number(p.target), protocol: p.protocol ?? 'tcp' })
      }
    }
    if (parsed.length) form.ports = parsed
  }

  if (svc.environment) {
    const envs: EnvVar[] = []
    if (Array.isArray(svc.environment)) {
      for (const e of svc.environment) {
        const idx = String(e).indexOf('=')
        if (idx > 0) envs.push({ key: e.slice(0, idx), value: e.slice(idx + 1) })
      }
    } else {
      for (const [k, v] of Object.entries(svc.environment)) envs.push({ key: k, value: String(v ?? '') })
    }
    if (envs.length) form.envs = envs
  }

  if (Array.isArray(svc.volumes)) {
    const vols: VolumeMount[] = []
    for (const v of svc.volumes) {
      if (typeof v === 'string') {
        const parts = v.split(':')
        if (parts.length >= 2) vols.push({ type: 'bind', source: parts[0]!, target: parts[1]! })
      } else if (typeof v === 'object' && v.target) {
        vols.push({ type: v.type ?? 'bind', source: v.source ?? '', target: v.target })
      }
    }
    if (vols.length) form.volumes = vols
  }

  if (svc.networks) {
    const nets: string[] = Array.isArray(svc.networks) ? svc.networks : Object.keys(svc.networks)
    if (nets.length) form.networkNames = nets
  }

  if (svc.labels) {
    const lbls: LabelEntry[] = []
    if (Array.isArray(svc.labels)) {
      for (const l of svc.labels) { const idx = String(l).indexOf('='); if (idx > 0) lbls.push({ key: l.slice(0, idx), value: l.slice(idx + 1) }) }
    } else {
      for (const [k, v] of Object.entries(svc.labels)) lbls.push({ key: k, value: String(v ?? '') })
    }
    if (lbls.length) form.labels = lbls
  }

  if (Array.isArray(svc.cap_add))  form.capAdd  = svc.cap_add
  if (Array.isArray(svc.cap_drop)) form.capDrop = svc.cap_drop

  // extra_hosts: ["host:ip"] or { host: "ip" }
  if (svc.extra_hosts) {
    const hosts: string[] = []
    if (Array.isArray(svc.extra_hosts)) {
      for (const h of svc.extra_hosts) hosts.push(String(h))
    } else {
      for (const [k, v] of Object.entries(svc.extra_hosts)) hosts.push(`${k}:${v}`)
    }
    if (hosts.length) form.extraHosts = hosts
  }
  if (svc.restart) form.restartPolicy = svc.restart
  if (svc.hostname) form.hostname = svc.hostname
  if (svc.user)     form.user     = String(svc.user)
  if (svc.command != null) {
    form.command = Array.isArray(svc.command) ? svc.command.join(' ') : String(svc.command)
  }

  const limits = svc.deploy?.resources?.limits
  if (limits?.cpus)   form.cpuLimit    = parseFloat(limits.cpus)
  if (limits?.memory) form.memoryLimit = String(limits.memory).toLowerCase()

  showCompose.value = false
  activeTab.value = 'basic'
}

// ─────────────────────────────────────────────────────────────────────────────

onMounted(async () => {
  try {
    places.value = await trpc.place.list.query() as Place[]
  } catch {}
})

watch(() => props.editApp, (app) => {
  if (app) {
    Object.assign(form, {
      name:          app.name,
      image:         app.image,
      ports:         [...app.ports],
      envs:          [...app.envs],
      volumes:       [...app.volumes],
      networkNames:  [...app.networkNames],
      labels:        [...app.labels],
      capAdd:        [...app.capAdd],
      capDrop:       [...app.capDrop],
      extraHosts:    [...(app.extraHosts ?? [])],
      restartPolicy: app.restartPolicy,
      hostname:      app.hostname,
      user:          app.user,
      command:       app.command,
      cpuLimit:      app.cpuLimit,
      memoryLimit:   app.memoryLimit,
      pinnedUrl:     app.pinnedUrl ?? null,
    })
    activeTab.value = 'basic'
  } else {
    Object.assign(form, emptyForm())
    activeTab.value = 'basic'
  }
  showCompose.value = false
  error.value = ''
}, { immediate: true })

const advanced = computed<AdvancedConfig>({
  get:  () => ({ capAdd: form.capAdd, capDrop: form.capDrop, extraHosts: form.extraHosts, restartPolicy: form.restartPolicy, hostname: form.hostname, user: form.user, command: form.command, cpuLimit: form.cpuLimit, memoryLimit: form.memoryLimit }),
  set:  (v) => { Object.assign(form, v) },
})

function addNetwork() {
  const n = networkInput.value.trim()
  if (n && !form.networkNames.includes(n)) form.networkNames.push(n)
  networkInput.value = ''
}

async function save() {
  error.value = ''
  loading.value = true
  try {
    const payload = {
      name:          form.name,
      image:         form.image,
      ports:         form.ports,
      envs:          form.envs,
      volumes:       form.volumes,
      networkNames:  form.networkNames,
      labels:        form.labels,
      capAdd:        form.capAdd,
      capDrop:       form.capDrop,
      extraHosts:    form.extraHosts,
      restartPolicy: form.restartPolicy as any,
      hostname:      form.hostname,
      user:          form.user,
      command:       form.command,
      cpuLimit:      form.cpuLimit,
      memoryLimit:   form.memoryLimit,
      pinnedUrl:     form.pinnedUrl || null,
    }
    let result: any
    if (props.editApp) {
      result = await trpc.container.app.update.mutate({ id: props.editApp.id, data: payload })
    } else {
      result = await trpc.container.app.create.mutate(payload)
    }
    emit('saved', result.app)
    emit('close')
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to save'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="flex flex-col h-full">

    <!-- Header -->
    <div class="flex items-center gap-3 px-5 py-3 border-b border-[var(--c-border)] shrink-0">
      <button
        @click="emit('close')"
        class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors"
        title="Back"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/>
        </svg>
      </button>
      <h2 class="text-sm font-semibold text-[var(--c-text-1)] flex-1">
        {{ editApp ? `Edit — ${editApp.name}` : 'New App' }}
      </h2>
      <button
        @click="showCompose = !showCompose"
        :title="showCompose ? 'Close Compose import' : 'Import from compose.yml'"
        :class="[
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
          showCompose
            ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)] hover:opacity-80'
            : 'text-[var(--c-text-3)] hover:text-[var(--c-text-2)] hover:bg-[var(--c-hover)]',
        ]"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
        </svg>
        Import Compose
      </button>
    </div>

    <!-- Compose import panel -->
    <div v-if="showCompose" class="px-6 py-4 border-b border-[var(--c-border)] bg-[var(--c-surface-alt)]/60 space-y-3 shrink-0">
      <p class="text-xs text-[var(--c-text-3)]">Paste a <span class="font-mono">compose.yml</span> to auto-fill the form.</p>
      <textarea
        v-model="composeRaw"
        placeholder="version: '3.8'&#10;services:&#10;  app:&#10;    image: nginx:alpine&#10;    ports:&#10;      - '8080:80'"
        rows="8"
        class="w-full bg-[var(--c-surface-deep)] border border-[var(--c-border-strong)] rounded-lg px-3 py-2 text-xs font-mono text-[var(--c-text-2)] focus:outline-none focus:border-[var(--c-accent)] resize-none"
      />
      <div class="flex items-center gap-3">
        <div v-if="composeServices.length > 1" class="flex items-center gap-2 flex-1">
          <label class="text-xs text-[var(--c-text-3)] whitespace-nowrap">Service:</label>
          <select
            v-model="composeSelectedService"
            class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-3 py-1.5 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
          >
            <option v-for="s in composeServices" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>
        <div v-else-if="composeServices.length === 1" class="flex-1 text-xs text-[var(--c-text-3)]">
          Service: <span class="font-mono text-[var(--c-text-2)]">{{ composeServices[0] }}</span>
        </div>
        <div v-else class="flex-1" />
        <p v-if="composeError" class="text-xs text-[var(--c-accent)] mr-2">{{ composeError }}</p>
        <button
          @click="importCompose"
          :disabled="!composeRaw.trim()"
          class="btn btn-primary btn-sm whitespace-nowrap"
        >
          Import &amp; fill form
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex border-b border-[var(--c-border)] px-5 overflow-x-auto shrink-0">
      <button
        v-for="tab in tabs" :key="tab.id"
        @click="activeTab = tab.id"
        :class="[
          'px-3 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors',
          activeTab === tab.id
            ? 'border-[var(--c-accent)] text-[var(--c-accent)]'
            : 'border-transparent text-[var(--c-text-3)] hover:text-[var(--c-text-2)]',
        ]"
      >{{ tab.label }}</button>
    </div>

    <!-- Tab content -->
    <div class="flex-1 overflow-y-auto px-6 py-5">

      <!-- Basic -->
      <div v-if="activeTab === 'basic'" class="space-y-4">
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">Container name *</label>
          <input
            v-model="form.name" placeholder="my-app" :disabled="!!editApp"
            class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-3 py-2 text-sm text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)] disabled:opacity-50"
          />
        </div>
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">Image *</label>
          <input
            v-model="form.image" placeholder="nginx:alpine"
            class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-3 py-2 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
          />
        </div>
        <div class="space-y-1.5 pt-3 border-t border-[var(--c-border)]">
          <label class="text-xs font-medium text-[var(--c-text-3)] uppercase tracking-wide">URL sidebar (optional)</label>
          <input
            v-model="form.pinnedUrl" placeholder="http://192.168.1.x:8080"
            class="w-full bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-3 py-2 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
          />
          <p class="text-xs text-[var(--c-text-3)]">Pins the app in the sidebar if set.</p>
        </div>
      </div>

      <!-- Ports -->
      <div v-else-if="activeTab === 'ports'">
        <PortsTable v-model="form.ports" :app-id="editApp?.id" />
      </div>

      <!-- Envs -->
      <div v-else-if="activeTab === 'envs'">
        <EnvsEditor v-model="form.envs" />
      </div>

      <!-- Volumes -->
      <div v-else-if="activeTab === 'volumes'">
        <VolumesTable v-model="form.volumes" :places="places" />
      </div>

      <!-- Networks -->
      <div v-else-if="activeTab === 'networks'" class="space-y-3">
        <p class="text-xs text-[var(--c-text-3)]">Enter container network names to attach (e.g. <span class="font-mono">bridge</span>, <span class="font-mono">host</span>, or a custom network).</p>
        <div class="flex gap-2">
          <input
            v-model="networkInput" placeholder="network-name"
            @keydown.enter.prevent="addNetwork"
            class="flex-1 bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-lg px-2 py-1.5 text-sm font-mono text-[var(--c-text-1)] focus:outline-none focus:border-[var(--c-accent)]"
          />
          <button
            @click="addNetwork"
            class="px-3 py-1.5 bg-[var(--c-accent-subtle)] text-[var(--c-accent)] rounded-lg text-sm hover:opacity-80 transition-colors"
          >Add</button>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="n in form.networkNames" :key="n"
            class="inline-flex items-center gap-1 text-xs bg-[var(--c-accent-subtle)] text-[var(--c-accent)] border border-[var(--c-border-strong)] rounded-sm px-2 py-0.5 font-mono"
          >
            {{ n }}
            <button @click="form.networkNames = form.networkNames.filter(x => x !== n)" class="hover:opacity-60 ml-1">×</button>
          </span>
          <span v-if="form.networkNames.length === 0" class="text-xs text-[var(--c-text-3)]">No networks attached.</span>
        </div>
      </div>

      <!-- Labels -->
      <div v-else-if="activeTab === 'labels'">
        <LabelsTable v-model="form.labels" />
      </div>

      <!-- Advanced -->
      <div v-else-if="activeTab === 'advanced'">
        <AdvancedSection v-model="advanced" />
      </div>

    </div>

    <!-- Footer -->
    <div class="flex items-center gap-3 px-5 py-3 border-t border-[var(--c-border)] shrink-0">
      <p v-if="error" class="text-sm text-[var(--c-accent)] flex-1">{{ error }}</p>
      <div v-else class="flex-1" />
      <button
        @click="emit('close')"
        class="btn btn-ghost"
      >Cancel</button>
      <button
        @click="save" :disabled="loading || !form.name || !form.image"
        class="btn btn-primary"
      >
        {{ loading ? 'Saving…' : 'Save' }}
      </button>
    </div>

  </div>
</template>
