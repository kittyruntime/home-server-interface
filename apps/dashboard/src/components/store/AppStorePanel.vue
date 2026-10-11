<script setup lang="ts">
import LoadingState from '../ui/LoadingState.vue'
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { trpc } from '../../lib/trpc'
import AppInstallWizard from './AppInstallWizard.vue'
import DockerUnavailable from '../apps/DockerUnavailable.vue'
import { useDockerStatus } from '../../lib/docker'
import { applyPlanned } from '../../lib/plan'
import { pollJobResult } from '../../lib/jobs'
import { rollbackPlan, updatePlan, updateText } from '../../lib/app-update'

type Entry = Awaited<ReturnType<typeof trpc.catalog.list.query>>[number]

const apps = ref<Entry[]>([])
const loading = ref(true)
const search = ref('')
const category = ref<string>('All')
const selected = ref<Entry | null>(null)
// The App Store is only offered when installs can actually run.
const { check: checkDocker, ready: dockerReady } = useDockerStatus()

const categories = computed(() => ['All', ...new Set(apps.value.map(a => a.category))])
const filtered = computed(() => apps.value.filter(a =>
  (category.value === 'All' || a.category === category.value) &&
  (a.name.toLowerCase().includes(search.value.toLowerCase()) || a.tagline.toLowerCase().includes(search.value.toLowerCase()))
))

const installedCount = computed(() => apps.value.filter(a => a.installed).length)

/** Collapse the persisted container status into a card state. Freshly-installed
 *  apps sit in pending/unknown/created until the worker reports them running:
 *  we surface that as "Installing…" so the ◐ → ● transition is visible. */
type CardState = 'none' | 'installing' | 'running' | 'stopped' | 'error'
function cardState(a: Entry): CardState {
  if (!a.installedApp) return 'none'
  switch (a.installedApp.status) {
    case 'running': return 'running'
    case 'stopped': return 'stopped'
    case 'error':   return 'error'
    default:        return 'installing'
  }
}
const STATE_META: Record<CardState, { label: string; dot: string; text: string }> = {
  none:       { label: 'Not installed', dot: '',                                      text: 'text-[var(--c-text-3)]' },
  installing: { label: 'Installing…',   dot: 'bg-[var(--c-warning)] animate-pulse',   text: 'text-[var(--c-warning)]' },
  running:    { label: 'Running',       dot: 'bg-[var(--c-success)]',                 text: 'text-[var(--c-success)]' },
  stopped:    { label: 'Stopped',       dot: 'bg-[var(--c-text-3)]',                  text: 'text-[var(--c-text-3)]' },
  error:      { label: 'Error',         dot: 'bg-[var(--c-accent)]',                  text: 'text-[var(--c-accent)]' },
}

function openWizard(a: Entry) { selected.value = a }

// Updates (#26): previewed as a plan, then the list is read again.
const busy = ref<string | null>(null)
const actionError = ref<{ id: string; message: string } | null>(null)
async function runPlan(a: Entry, op: 'app.update' | 'app.rollback') {
  const inst = a.installedApp
  if (!inst) return
  const opts = op === 'app.update' && inst.update ? updatePlan(inst.name, inst.update) : rollbackPlan(inst.name, inst.rollbackTo ?? '')
  busy.value = a.id
  actionError.value = null
  try {
    const reply = await applyPlanned(op, { name: inst.name }, { ...opts, domain: 'apps' })
    // The new image is pulled and the app recreated by a job: a pull that
    // fails leaves the old container running, which must not go unnoticed.
    if (typeof reply.jobId === 'string') {
      await refresh()
      const result = await pollJobResult(reply.jobId, 10 * 60_000) // a pull can be long
      if (result.status !== 'completed') {
        actionError.value = { id: a.id, message: `${opts.actionLabel} of ${inst.name} failed: ${result.error ?? 'the app could not be recreated'}` }
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (message) actionError.value = { id: a.id, message }
  } finally {
    busy.value = null
    await refresh()
  }
}
function openApp(a: Entry) {
  // Prefer the port's configured domain/HTTPS binding; else the mapped host port.
  const url = a.installedApp?.webUrl
    ?? (a.installedApp?.webPort != null ? `http://${location.hostname}:${a.installedApp.webPort}` : null)
  if (!url) return
  window.open(url, '_blank')
}

async function refresh() {
  try { apps.value = await trpc.catalog.list.query() } catch { /* keep last list */ }
}
async function load() {
  loading.value = true
  try { await refresh() } finally { loading.value = false }
}

let poll: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void checkDocker()
  load()
  // Light polling so install → running (and stop/error) transitions show without
  // a manual reload. Paused while the wizard is open (grid isn't visible then).
  poll = setInterval(() => { if (!selected.value && !document.hidden) refresh() }, 6000)
})
onUnmounted(() => { if (poll !== null) clearInterval(poll) })
</script>

<template>
  <DockerUnavailable v-if="!dockerReady()" />
  <div v-else class="h-full overflow-y-auto p-4 sm:p-6">
    <div v-if="selected">
      <button class="btn btn-ghost btn-sm mb-3" @click="selected = null">← Back</button>
      <AppInstallWizard :app-id="selected.id" @installed="selected = null; load()" @close="selected = null" />
    </div>

    <template v-else>
      <!-- Header -->
      <div class="flex flex-col items-stretch gap-3 mb-1 sm:flex-row sm:items-center sm:justify-between">
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">App Store</h2>
        <input v-model="search" placeholder="Search apps…" class="ui-input max-w-xs" />
      </div>
      <!-- Counts and categories only once the catalog is read: "0 apps" would be wrong. -->
      <p v-if="!loading" class="text-xs text-[var(--c-text-3)] mb-4">
        {{ apps.length }} apps · {{ installedCount }} installed
      </p>

      <!-- Category filter -->
      <div v-if="!loading" class="flex gap-2 mb-4 flex-wrap">
        <button v-for="c in categories" :key="c" @click="category = c"
          :class="['btn btn-xs', category === c ? 'btn-primary' : 'btn-outline']">{{ c }}</button>
      </div>

      <LoadingState v-if="loading" />

      <!-- No results -->
      <div v-else-if="filtered.length === 0" class="text-center py-16 text-[var(--c-text-3)]">
        <p class="text-sm">No apps match “{{ search }}”.</p>
        <button class="btn btn-ghost btn-sm mt-2" @click="search = ''; category = 'All'">Clear filters</button>
      </div>

      <!-- Grid -->
      <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <div
          v-for="a in filtered" :key="a.id"
          class="panel-card p-4 flex flex-col gap-3 transition-colors"
          :class="cardState(a) === 'none' ? 'cursor-pointer hover:border-[var(--c-border-strong)]' : ''"
          @click="cardState(a) === 'none' && openWizard(a)"
        >
          <!-- Identity -->
          <div class="flex gap-3 items-start min-w-0">
            <!-- eslint-disable-next-line vue/no-v-html -- `a.icon` is a bundled first-party brand logo from @app/app-catalog, not user input. -->
            <span class="w-10 h-10 shrink-0 grid place-items-center" v-html="a.icon" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-[var(--c-text-1)] truncate">{{ a.name }}</span>
                <span class="text-2xs uppercase tracking-caps text-[var(--c-text-3)] shrink-0">{{ a.category }}</span>
              </div>
              <p class="text-xs text-[var(--c-text-3)] mt-0.5 leading-relaxed line-clamp-2">{{ a.tagline }}</p>
            </div>
          </div>

          <!-- Update available (#26) -->
          <div v-if="a.installedApp?.update" class="flex items-center gap-2 flex-wrap text-xs text-[var(--c-warning)]">
            <span>{{ updateText(a.installedApp.update) }}</span>
            <a v-if="a.changelog" :href="a.changelog" target="_blank" rel="noopener noreferrer" class="underline hover:text-[var(--c-text-1)]" @click.stop>What's new ↗</a>
          </div>
          <p v-if="actionError?.id === a.id" role="alert" class="status-text text-danger break-words"><span class="status-tag">[ERR]</span> {{ actionError.message }}</p>

          <!-- State + action -->
          <div class="flex items-center justify-between gap-2 mt-auto pt-1">
            <span class="inline-flex items-center gap-1.5 text-xs" :class="STATE_META[cardState(a)].text">
              <span v-if="STATE_META[cardState(a)].dot" class="w-1.5 h-1.5 rounded-full" :class="STATE_META[cardState(a)].dot" />
              {{ STATE_META[cardState(a)].label }}
            </span>

            <div class="flex items-center gap-1.5 flex-wrap justify-end">
              <button
                v-if="a.installedApp?.rollbackTo && !a.installedApp.update"
                class="btn btn-ghost btn-xs"
                :disabled="busy === a.id"
                @click.stop="runPlan(a, 'app.rollback')"
              >Roll back to {{ a.installedApp.rollbackTo }}…</button>
              <button
                v-if="a.installedApp?.update"
                class="btn btn-primary btn-xs"
                :disabled="busy === a.id"
                @click.stop="runPlan(a, 'app.update')"
              >Update…</button>
              <button
                v-if="cardState(a) === 'none'"
                class="btn btn-primary btn-xs"
                @click.stop="openWizard(a)"
              >Install</button>
              <button
                v-else-if="a.installedApp?.webUrl || a.installedApp?.webPort != null"
                class="btn btn-outline btn-xs"
                @click.stop="openApp(a)"
              >Open ↗</button>
              <span v-else-if="!a.installedApp?.update" class="badge badge-muted">Installed</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
