<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'

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
    error.value = e?.message ?? 'Failed to load'
  } finally {
    loading.value = false
  }
}

async function toggle() {
  expanded.value = !expanded.value
  if (expanded.value && !containers.value.length && !loading.value) await load()
}

async function importContainer(c: UnmanagedContainer) {
  if (!confirm(`Import "${c.name}" into Brume?\n\nThe container will be added to the managed list. Its current config (ports, volumes, networks) will be recorded.\n${c.composeProject ? `\nNote: this container is part of docker-compose project "${c.composeProject}". Managing it individually may conflict with compose.` : ''}`)) return

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
    alert(e?.message ?? 'Import failed')
  } finally {
    const next = new Set(importing.value)
    next.delete(c.name)
    importing.value = next
  }
}

function statusDot(status: string) {
  switch (status) {
    case 'running': return 'bg-emerald-500'
    case 'exited':
    case 'stopped': return 'bg-slate-600'
    default:        return 'bg-amber-500'
  }
}

onMounted(() => {
  // pre-load silently so count shows on mount
  load()
})
</script>

<template>
  <div class="border-t border-[var(--c-border)] mt-auto">

    <!-- Toggle header -->
    <button
      @click="toggle"
      class="w-full flex items-center gap-2 px-6 py-3 text-left hover:bg-[var(--c-hover)] transition-colors group"
    >
      <svg
        :class="['w-3 h-3 text-slate-600 transition-transform duration-150', expanded ? 'rotate-90' : '']"
        fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
      </svg>

      <span class="text-[11px] font-semibold text-slate-500 uppercase tracking-widest group-hover:text-slate-400 transition-colors">
        Unmanaged containers
      </span>

      <span
        v-if="!loading && containers.length"
        class="ml-1 px-1.5 py-0.5 text-[10px] font-semibold bg-slate-700 text-slate-400 rounded-full leading-none"
      >{{ containers.length }}</span>

      <svg
        v-if="loading"
        class="w-3 h-3 text-slate-600 animate-spin ml-1"
        fill="none" viewBox="0 0 24 24"
      >
        <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
      </svg>
    </button>

    <!-- Expanded content -->
    <div v-if="expanded" class="pb-3">

      <div v-if="error" class="px-6 py-2 text-xs text-red-400">{{ error }}</div>

      <div
        v-else-if="!loading && containers.length === 0"
        class="px-6 py-3 text-xs text-slate-600"
      >
        No unmanaged containers found.
      </div>

      <table v-else-if="containers.length" class="w-full text-sm table-fixed">
        <colgroup>
          <col class="w-[22%]" />
          <col class="w-[35%]" />
          <col class="w-[18%]" />
          <col class="w-[11%]" />
          <col class="w-[14%]" />
        </colgroup>
        <tbody class="divide-y divide-[var(--c-border)]/50">
          <tr
            v-for="c in containers" :key="c.name"
            class="group hover:bg-[var(--c-hover)]/50 transition-colors"
          >
            <!-- Name + compose badge -->
            <td class="px-6 py-3">
              <div class="flex items-center gap-2 min-w-0">
                <span class="font-mono text-slate-400 text-[13px] truncate">{{ c.name }}</span>
              </div>
              <div v-if="c.composeProject" class="flex items-center gap-1 mt-0.5">
                <svg class="w-3 h-3 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
                </svg>
                <span class="text-[10px] text-amber-500/80 font-medium truncate">
                  compose: {{ c.composeProject }}<span v-if="c.composeService"> / {{ c.composeService }}</span>
                </span>
              </div>
            </td>

            <!-- Image -->
            <td class="px-3 py-3">
              <span class="font-mono text-slate-500 text-xs truncate block">{{ c.image }}</span>
            </td>

            <!-- Ports -->
            <td class="px-3 py-3">
              <span class="font-mono text-slate-600 text-xs">
                {{ c.ports.length ? c.ports.slice(0, 2).map(p => `${p.hostPort}:${p.containerPort}`).join(', ') + (c.ports.length > 2 ? ` +${c.ports.length - 2}` : '') : '—' }}
              </span>
            </td>

            <!-- Status -->
            <td class="px-3 py-3">
              <span class="flex items-center gap-1.5">
                <span :class="['w-1.5 h-1.5 rounded-full flex-shrink-0', statusDot(c.status)]" />
                <span class="text-xs text-slate-600 capitalize">{{ c.status }}</span>
              </span>
            </td>

            <!-- Import -->
            <td class="px-6 py-3 text-right">
              <button
                @click="importContainer(c)"
                :disabled="importing.has(c.name)"
                class="px-2.5 py-1 text-[11px] font-medium text-slate-400 border border-slate-700 rounded-lg hover:border-[var(--c-accent)] hover:text-[var(--c-accent)] disabled:opacity-40 transition-colors"
              >
                {{ importing.has(c.name) ? 'Importing…' : 'Import' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

    </div>
  </div>
</template>
