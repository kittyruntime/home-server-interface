<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ChevronRightIcon, CircleAlertIcon, RefreshCwIcon, TriangleIcon } from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import LoadingSpinner from '../ui/LoadingSpinner.vue'
import { ref } from 'vue'
import { trpc } from '../../lib/trpc'
import { useToast } from '../../lib/toast'
import { usePoll } from '../../lib/poll'

const { t } = useI18n()

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

async function load() {
  loading.value = true
  error.value   = null
  try {
    containers.value = (await trpc.container.app.listUnmanaged.query()) as UnmanagedContainer[]
  } catch (e: any) {
    error.value = e?.message ?? t('uis.apps.UnmanagedContainers.failedToLoad')
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
    toast.error(e?.message ?? t('uis.apps.UnmanagedContainers.importFailed'))
  } finally {
    const next = new Set(importing.value)
    next.delete(c.name)
    importing.value = next
  }
}

function statusColor(status: string) {
  switch (status) {
    case 'running': return 'bg-success'
    case 'exited':
    case 'stopped': return 'bg-base-content/40'
    default:        return 'bg-warning'
  }
}

function portsSummary(c: UnmanagedContainer): string {
  if (!c.ports.length) return ''
  const shown = c.ports.slice(0, 3).map(p => `${p.hostPort}:${p.containerPort}`).join('  ')
  return c.ports.length > 3 ? `${shown}  +${c.ports.length - 3}` : shown
}

usePoll(load, 60_000)
</script>

<template>
  <div>

    <!-- Header row -->
    <div class="flex items-center">
      <Button
        variant="ghost"
        class="group -ml-1 h-auto flex-1 justify-start gap-2 px-1 py-1.5 text-left hover:bg-transparent"
        :aria-expanded="expanded"
        @click="toggle"
      >
        <ChevronRightIcon :class="['size-4 shrink-0 text-base-content/60 transition-transform', expanded && 'rotate-90']" aria-hidden="true" />
        <span class="select-none text-lg font-semibold tracking-tight text-base-content">{{ t('ui.apps.UnmanagedContainers.unmanaged') }}</span>
        <Badge v-if="!loading && containers.length" variant="secondary" class="h-4 min-w-[18px] rounded-full px-1.5 text-2xs tabular-nums">
          {{ containers.length }}
        </Badge>
        <LoadingSpinner v-if="loading" class="text-xs text-base-content/70" />
      </Button>

      <Button variant="ghost" size="icon-xs" class="text-base-content/70" :disabled="loading" :tooltip="t('ui.apps.UnmanagedContainers.refresh')" :aria-label="t('ui.apps.UnmanagedContainers.refreshUnmanagedContainers')" @click="load">
        <RefreshCwIcon class="size-3.5" aria-hidden="true" />
      </Button>
    </div>

    <!-- Expanded content -->
    <Transition name="ui-fade">
      <div v-if="expanded" class="pt-2 pb-3">

        <div v-if="error" role="alert" class="mx-2 mb-2 flex items-start gap-2 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
          <CircleAlertIcon class="size-3.5 shrink-0" aria-hidden="true" />
          {{ error }}
        </div>

        <div v-else-if="!loading && containers.length === 0" class="px-2 pb-2 pt-1 text-xs text-base-content/70">
          {{ t('ui.apps.UnmanagedContainers.noUnmanagedContainers') }}
        </div>

        <ul v-else class="flex flex-col gap-1.5">
          <li
            v-for="c in containers"
            :key="c.name"
            class="flex min-w-0 items-center gap-3.5 rounded-lg border border-base-300 bg-base-200 px-3.5 py-2.5 transition-colors hover:border-primary/40"
          >
            <!-- Left: status + identity -->
            <div class="flex min-w-0 flex-1 items-center gap-2.5">
              <span :class="['size-[7px] shrink-0 rounded-full', statusColor(c.status)]" />
              <div class="flex min-w-0 flex-col gap-px">
                <span class="truncate font-mono text-sm font-medium text-base-content/80">{{ c.name }}</span>
                <span class="truncate font-mono text-2xs text-base-content/70">{{ c.image }}</span>
              </div>
            </div>

            <!-- Ports (hidden on small screens) -->
            <span v-if="portsSummary(c)" class="hidden shrink-0 whitespace-nowrap font-mono text-2xs text-base-content/70 md:block">
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
