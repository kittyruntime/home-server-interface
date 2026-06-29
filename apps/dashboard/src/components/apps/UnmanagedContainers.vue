<script setup lang="ts">
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
  if (!confirm(`Import "${c.name}"?\n\nThe container will be added to the managed list. Its current config (ports, volumes, networks) will be recorded.\n${c.composeProject ? `\nNote: this container is part of docker-compose project "${c.composeProject}". Managing it individually may conflict with compose.` : ''}`)) return

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

function statusColor(status: string) {
  switch (status) {
    case 'running': return 'var(--status-running)'
    case 'exited':
    case 'stopped': return 'var(--status-stopped)'
    default:        return 'var(--status-other)'
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
  <div class="unmanaged-root">

    <!-- Header row -->
    <div class="header-row">
      <button class="toggle-btn" @click="toggle">
        <svg
          :class="['chevron', { 'chevron--open': expanded }]"
          viewBox="0 0 16 16" fill="none"
        >
          <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="section-label">Unmanaged</span>
        <span v-if="!loading && containers.length" class="count-badge">
          {{ containers.length }}
        </span>
        <svg v-if="loading" class="spin-icon" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-dasharray="40 20" />
        </svg>
      </button>

      <button class="refresh-btn" @click="load" :disabled="loading" title="Refresh">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
      </button>
    </div>

    <!-- Expanded content -->
    <Transition name="slide">
      <div v-if="expanded" class="content">

        <div v-if="error" class="state-msg state-msg--error">
          <svg viewBox="0 0 16 16" fill="none" class="state-icon">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.25"/>
            <path d="M8 5v3.5M8 11h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          {{ error }}
        </div>

        <div v-else-if="!loading && containers.length === 0" class="state-msg">
          No unmanaged containers.
        </div>

        <ul v-else class="card-list">
          <li
            v-for="c in containers"
            :key="c.name"
            class="card"
          >
            <!-- Left: status + identity -->
            <div class="card-identity">
              <span class="status-pip" :style="{ background: statusColor(c.status) }" />
              <div class="identity-text">
                <span class="container-name">{{ c.name }}</span>
                <span class="container-image">{{ c.image }}</span>
              </div>
            </div>

            <!-- Ports (hidden on small screens) -->
            <span v-if="portsSummary(c)" class="ports-label">
              {{ portsSummary(c) }}
            </span>

            <!-- Compose badge (hidden on small screens) -->
            <span v-if="c.composeProject" class="compose-badge">
              <svg viewBox="0 0 12 12" fill="none" class="compose-icon">
                <path d="M6 1.5L10.5 9H1.5L6 1.5Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
              </svg>
              {{ c.composeProject }}
            </span>

            <!-- Import button -->
            <button
              class="import-btn"
              @click="importContainer(c)"
              :disabled="importing.has(c.name)"
            >
              <svg v-if="importing.has(c.name)" class="btn-spin" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="2" stroke-dasharray="24 12" />
              </svg>
              {{ importing.has(c.name) ? 'Importing…' : 'Import' }}
            </button>
          </li>
        </ul>

      </div>
    </Transition>
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.unmanaged-root {
  --status-running: #22c55e;
  --status-stopped: color-mix(in srgb, var(--c-text-3) 60%, transparent);
  --status-other:   #f59e0b;
  border-top: 1px solid var(--c-border);
}

/* ── Header ── */
.header-row {
  display: flex;
  align-items: center;
  padding: 0 1rem 0 1.25rem;
}

.toggle-btn {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 0.25rem;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
}
.toggle-btn:hover .section-label { color: var(--c-text-2); }

.chevron {
  width: 12px;
  height: 12px;
  color: var(--c-text-3);
  flex-shrink: 0;
  transition: transform 0.18s ease;
}
.chevron--open { transform: rotate(90deg); }

.section-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--c-text-3);
  transition: color 0.15s;
  user-select: none;
}

.count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 5px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  color: var(--c-text-3);
  background: color-mix(in srgb, var(--c-text-3) 12%, transparent);
  border-radius: 999px;
}

.spin-icon {
  width: 12px;
  height: 12px;
  color: var(--c-text-3);
  animation: spin 0.8s linear infinite;
}

.refresh-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: none;
  border: none;
  color: var(--c-text-3);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
  flex-shrink: 0;
}
.refresh-btn:hover:not(:disabled) {
  color: var(--c-text-2);
  background: var(--c-hover);
}
.refresh-btn:disabled { opacity: 0.4; cursor: default; }
.refresh-btn svg { width: 13px; height: 13px; }

/* ── Content ── */
.content {
  padding: 0 0.75rem 0.75rem;
}

.state-msg {
  font-size: 12px;
  color: var(--c-text-3);
  padding: 0.25rem 0.5rem 0.5rem;
}
.state-msg--error {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  color: #f87171;
}
.state-icon { width: 13px; height: 13px; flex-shrink: 0; }

/* ── Card list ── */
.card-list {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.card {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  padding: 0.625rem 0.875rem;
  background: var(--c-surface-alt);
  border: 1px solid var(--c-border);
  border-radius: 10px;
  transition: border-color 0.15s;
  min-width: 0;
}
.card:hover { border-color: color-mix(in srgb, var(--c-border) 60%, var(--c-accent) 40%); }

/* Status + identity */
.card-identity {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  flex: 1;
  min-width: 0;
}

.status-pip {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.identity-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 1px;
}

.container-name {
  font-family: ui-monospace, monospace;
  font-size: 13px;
  font-weight: 500;
  color: var(--c-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.container-image {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--c-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Ports */
.ports-label {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--c-text-3);
  white-space: nowrap;
  flex-shrink: 0;
  display: none;
}
@media (min-width: 768px) { .ports-label { display: block; } }

/* Compose badge */
.compose-badge {
  display: none;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-weight: 600;
  color: #f59e0b;
  white-space: nowrap;
  flex-shrink: 0;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}
@media (min-width: 1024px) { .compose-badge { display: flex; } }
.compose-icon { width: 10px; height: 10px; flex-shrink: 0; }

/* Import button */
.import-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.3125rem 0.75rem;
  font-size: 11px;
  font-weight: 600;
  color: var(--c-accent);
  background: var(--c-accent-subtle);
  border: 1px solid color-mix(in srgb, var(--c-accent) 35%, transparent);
  border-radius: 7px;
  cursor: pointer;
  flex-shrink: 0;
  white-space: nowrap;
  transition: background 0.15s, opacity 0.15s;
}
.import-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--c-accent) 20%, transparent);
}
.import-btn:disabled { opacity: 0.4; cursor: default; }

.btn-spin {
  width: 11px;
  height: 11px;
  animation: spin 0.7s linear infinite;
}

/* ── Transitions ── */
.slide-enter-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.slide-leave-active { transition: opacity 0.14s ease, transform 0.12s ease; }
.slide-enter-from   { opacity: 0; transform: translateY(-4px); }
.slide-leave-to     { opacity: 0; transform: translateY(-4px); }

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
