<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { trpc } from '../../lib/trpc'
import AppInstallWizard from './AppInstallWizard.vue'

type Entry = Awaited<ReturnType<typeof trpc.catalog.list.query>>[number]

const apps = ref<Entry[]>([])
const loading = ref(true)
const search = ref('')
const category = ref<string>('All')
const selected = ref<Entry | null>(null)

const categories = computed(() => ['All', ...new Set(apps.value.map(a => a.category))])
const filtered = computed(() => apps.value.filter(a =>
  (category.value === 'All' || a.category === category.value) &&
  (a.name.toLowerCase().includes(search.value.toLowerCase()) || a.tagline.toLowerCase().includes(search.value.toLowerCase()))
))

const installedCount = computed(() => apps.value.filter(a => a.installed).length)

/** Collapse the persisted container status into a card state. Freshly-installed
 *  apps sit in pending/unknown/created until the worker reports them running —
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
function openApp(a: Entry) {
  if (a.installedApp?.webPort == null) return
  window.open(`http://${location.hostname}:${a.installedApp.webPort}`, '_blank')
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
  load()
  // Light polling so install → running (and stop/error) transitions show without
  // a manual reload. Paused while the wizard is open (grid isn't visible then).
  poll = setInterval(() => { if (!selected.value && !document.hidden) refresh() }, 6000)
})
onUnmounted(() => { if (poll !== null) clearInterval(poll) })
</script>

<template>
  <div class="h-full overflow-y-auto p-6">
    <div v-if="selected">
      <button class="btn btn-ghost btn-sm mb-3" @click="selected = null">← Back</button>
      <AppInstallWizard :app-id="selected.id" @installed="selected = null; load()" @close="selected = null" />
    </div>

    <template v-else>
      <!-- Header -->
      <div class="flex items-center justify-between gap-3 mb-1">
        <h2 class="text-base font-semibold text-[var(--c-text-1)]">App Store</h2>
        <input v-model="search" placeholder="Search apps…" class="ui-input max-w-xs" />
      </div>
      <p class="text-xs text-[var(--c-text-3)] mb-4">
        {{ apps.length }} apps · {{ installedCount }} installed
      </p>

      <!-- Category filter -->
      <div class="flex gap-2 mb-4 flex-wrap">
        <button v-for="c in categories" :key="c" @click="category = c"
          :class="['btn btn-xs', category === c ? 'btn-primary' : 'btn-outline']">{{ c }}</button>
      </div>

      <!-- Loading skeleton -->
      <div v-if="loading" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <div v-for="n in 6" :key="n" class="panel-card p-4 h-[104px] animate-pulse">
          <div class="flex gap-3">
            <div class="w-10 h-10 rounded-lg bg-[var(--c-border)] shrink-0" />
            <div class="flex-1 space-y-2 pt-1">
              <div class="h-3 w-1/2 rounded bg-[var(--c-border)]" />
              <div class="h-2.5 w-4/5 rounded bg-[var(--c-border)]" />
            </div>
          </div>
        </div>
      </div>

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
            <!-- eslint-disable-next-line vue/no-v-html -- `a.icon` is a bundled first-party SVG from @app/app-catalog, not user input. -->
            <span class="w-10 h-10 shrink-0 text-[var(--c-text-2)]" v-html="a.icon" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-[var(--c-text-1)] truncate">{{ a.name }}</span>
                <span class="text-[10px] uppercase tracking-wide text-[var(--c-text-3)] shrink-0">{{ a.category }}</span>
              </div>
              <p class="text-xs text-[var(--c-text-3)] mt-0.5 leading-relaxed line-clamp-2">{{ a.tagline }}</p>
            </div>
          </div>

          <!-- State + action -->
          <div class="flex items-center justify-between gap-2 mt-auto pt-1">
            <span class="inline-flex items-center gap-1.5 text-xs" :class="STATE_META[cardState(a)].text">
              <span v-if="STATE_META[cardState(a)].dot" class="w-1.5 h-1.5 rounded-full" :class="STATE_META[cardState(a)].dot" />
              {{ STATE_META[cardState(a)].label }}
            </span>

            <button
              v-if="cardState(a) === 'none'"
              class="btn btn-primary btn-xs"
              @click.stop="openWizard(a)"
            >Install</button>
            <button
              v-else-if="a.installedApp?.webPort != null"
              class="btn btn-outline btn-xs"
              @click.stop="openApp(a)"
            >Open ↗</button>
            <span v-else class="badge badge-muted">Installed</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
