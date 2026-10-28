<script setup lang="ts">
import { ChevronRightIcon, CircleAlertIcon, RefreshCwIcon, TriangleIcon } from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import { ref, onMounted, onUnmounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useToast } from '../../lib/toast'

const toast = useToast()

type UnmanagedContainer = {
  name:           string
  image:          string
  status:         string
  ports:          Array<{ hostPort: number; containerPort: number; protocol: string }>
  labels:         Record<string, string>
  volumes:        Array<{ type: string; source: string; target: string }>
  networkNames:   string[]
  composeProject: string | null
  composeService: string | null
  composeFile:    string | null
}

const emit = defineEmits<{ imported: [] }>()

const expanded   = ref(false)
const loading    = ref(false)
const containers = ref<UnmanagedContainer[]>([])
const importing  = ref<Set<string>>(new Set())
const error      = ref<string | null>(null)
const composeOpen = ref(false)
const composeName = ref('')
const composeContent = ref('')
const composeError = ref<string | null>(null)
const composeImporting = ref(false)
const composeFile = ref<HTMLInputElement | null>(null)
let   refreshTimer: ReturnType<typeof setInterval> | null = null

async function load() {
  loading.value = true
  error.value   = null
  try {
    containers.value = (await trpc.container.app.listUnmanaged.query()) as UnmanagedContainer[]
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load'
  } finally {
    loading.value = false
  }
}

async function toggle() {
  expanded.value = !expanded.value
  if (expanded.value) await load()
}

async function importContainer(c: UnmanagedContainer) {
  if (!confirm(`Import "${c.name}"?\n\nHSI will write a compose.yaml for it under /opt/containers/${c.name}/ (its current ports, volumes and networks are recorded). The container keeps running as-is and is adopted on the next Apply.\n${c.composeProject ? `\nNote: this container is part of docker-compose project "${c.composeProject}". Managing it individually may conflict with compose.` : ''}`)) return

  importing.value = new Set([...importing.value, c.name])
  try {
    await trpc.container.app.importContainer.mutate({
      name:         c.name,
      image:        c.image,
      ports:        c.ports.map(p => ({
        hostPort:      p.hostPort,
        containerPort: p.containerPort,
        protocol:      (p.protocol === 'udp' ? 'udp' : 'tcp') as 'tcp' | 'udp',
      })),
      volumes:      c.volumes.map(v => ({
        type:   (v.type === 'named' ? 'named' : 'bind') as 'bind' | 'named' | 'place',
        source: v.source,
        target: v.target,
      })),
      networkNames: c.networkNames,
      labels:       Object.entries(c.labels)
        .filter(([k]) => !k.startsWith('com.docker.'))
        .map(([key, value]) => ({ key, value })),
      envs:         [],
    })
    containers.value = containers.value.filter(x => x.name !== c.name)
    emit('imported')
  } catch (e: any) {
    toast.error(e?.message ?? 'Import failed')
  } finally {
    const next = new Set(importing.value)
    next.delete(c.name)
    importing.value = next
  }
}

function openComposeFile() {
  composeFile.value?.click()
}

async function readComposeFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  composeContent.value = await file.text()
  if (!composeName.value) composeName.value = file.name.replace(/\.ya?ml$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64)
}

async function importCompose() {
  composeError.value = null
  if (!composeName.value.trim()) { composeError.value = 'Enter an app name.'; return }
  if (!composeContent.value.trim()) { composeError.value = 'Paste a compose file or choose a file.'; return }
  composeImporting.value = true
  try {
    await trpc.container.app.importCompose.mutate({ name: composeName.value.trim(), content: composeContent.value })
    composeOpen.value = false
    composeName.value = ''
    composeContent.value = ''
    emit('imported')
  } catch (e: any) {
    composeError.value = e?.message ?? 'Import failed'
  } finally {
    composeImporting.value = false
  }
}

function statusColor(status: string) {
  switch (status) {
    case 'running': return 'bg-success'
    case 'exited':
    case 'stopped': return 'bg-muted-foreground/60'
    default:        return 'bg-warning'
  }
}

function portsSummary(c: UnmanagedContainer): string {
  if (!c.ports.length) return ''
  const shown = c.ports.slice(0, 3).map(p => `${p.hostPort}:${p.containerPort}`).join('  ')
  return c.ports.length > 3 ? `${shown}  +${c.ports.length - 3}` : shown
}

onMounted(() => {
  load()
  refreshTimer = setInterval(load, 60_000)
})

onUnmounted(() => {
  if (refreshTimer !== null) clearInterval(refreshTimer)
})
</script>

<template>
  <div class="border-t border-border">

    <!-- Header row -->
    <div class="flex items-center pl-5 pr-4">
      <button
        class="group flex flex-1 items-center gap-2 px-1 py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded-sm"
        :aria-expanded="expanded"
        @click="toggle"
      >
        <ChevronRightIcon :class="['size-3 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90']" aria-hidden="true" />
        <span class="select-none text-2xs font-bold uppercase tracking-caps text-muted-foreground transition-colors group-hover:text-foreground">Unmanaged</span>
        <Badge v-if="!loading && containers.length" variant="secondary" class="h-4 min-w-[18px] rounded-full px-1.5 text-2xs tabular-nums">
          {{ containers.length }}
        </Badge>
        <LoadingSpinner v-if="loading" class="text-xs text-muted-foreground" />
      </button>

      <Button variant="ghost" size="icon-xs" class="text-muted-foreground" :disabled="loading" title="Refresh" aria-label="Refresh unmanaged containers" @click="load">
        <RefreshCwIcon class="size-3.5" aria-hidden="true" />
      </Button>
    </div>

    <!-- Expanded content -->
    <Transition name="ui-fade">
      <div v-if="expanded" class="px-3 pb-3">

        <div class="mx-2 mb-3 rounded-lg border border-border p-3">
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs text-muted-foreground">Import compose file</span>
            <Button variant="outline" size="xs" @click="composeOpen = !composeOpen">{{ composeOpen ? 'Close' : 'Paste or upload' }}</Button>
          </div>
          <div v-if="composeOpen" class="mt-3 grid gap-2">
            <Input v-model="composeName" class="h-8 text-xs" placeholder="App name, for example media" maxlength="64" aria-label="App name" />
            <input ref="composeFile" type="file" accept=".yml,.yaml,text/yaml" class="hidden" @change="readComposeFile" />
            <Button variant="outline" size="xs" class="w-fit" type="button" @click="openComposeFile">Choose YAML file</Button>
            <Textarea v-model="composeContent" class="font-mono text-xs" rows="8" spellcheck="false" placeholder="services:\n  web:\n    image: nginx" aria-label="Compose file" />
            <p v-if="composeError" class="text-xs text-destructive" role="alert">{{ composeError }}</p>
            <Button size="sm" class="w-fit" :disabled="composeImporting" @click="importCompose">
              {{ composeImporting ? 'Importing…' : 'Import app' }}
            </Button>
          </div>
        </div>

        <div v-if="error" role="alert" class="flex items-center gap-1.5 px-2 pb-2 pt-1 text-xs text-destructive">
          <CircleAlertIcon class="size-3.5 shrink-0" aria-hidden="true" />
          {{ error }}
        </div>

        <div v-else-if="!loading && containers.length === 0" class="px-2 pb-2 pt-1 text-xs text-muted-foreground">
          No unmanaged containers.
        </div>

        <ul v-else class="flex flex-col gap-1.5">
          <li
            v-for="c in containers"
            :key="c.name"
            class="flex min-w-0 items-center gap-3.5 rounded-lg border border-border bg-muted px-3.5 py-2.5 transition-colors hover:border-primary/40"
          >
            <!-- Left: status + identity -->
            <div class="flex min-w-0 flex-1 items-center gap-2.5">
              <span :class="['size-[7px] shrink-0 rounded-full', statusColor(c.status)]" />
              <div class="flex min-w-0 flex-col gap-px">
                <span class="truncate font-mono text-sm font-medium text-foreground/80">{{ c.name }}</span>
                <span class="truncate font-mono text-2xs text-muted-foreground">{{ c.image }}</span>
              </div>
            </div>

            <!-- Ports (hidden on small screens) -->
            <span v-if="portsSummary(c)" class="hidden shrink-0 whitespace-nowrap font-mono text-2xs text-muted-foreground md:block">
              {{ portsSummary(c) }}
            </span>

            <!-- Compose badge (hidden on small screens) -->
            <span v-if="c.composeProject" class="hidden max-w-[120px] shrink-0 items-center gap-1 truncate text-2xs font-semibold text-warning lg:flex">
              <TriangleIcon class="size-2.5 shrink-0" aria-hidden="true" />
              {{ c.composeProject }}
            </span>

            <Button
              variant="outline"
              size="xs"
              class="shrink-0 border-primary/35 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary"
              :disabled="importing.has(c.name)"
              @click="importContainer(c)"
            >
              <LoadingSpinner v-if="importing.has(c.name)" class="text-xs" />
              {{ importing.has(c.name) ? 'Importing…' : 'Import' }}
            </Button>
          </li>
        </ul>

      </div>
    </Transition>
  </div>
</template>
