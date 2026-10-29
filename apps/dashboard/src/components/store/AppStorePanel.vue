<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import LoadingState from '../ui/LoadingState.vue'
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { trpc } from '../../lib/trpc'
import AppInstallWizard from './AppInstallWizard.vue'
import AppStoreDetail from './AppStoreDetail.vue'
import DockerUnavailable from '../apps/DockerUnavailable.vue'
import { useDockerStatus } from '../../lib/docker'
import { applyPlanned } from '../../lib/plan'
import { pollJobResult } from '../../lib/jobs'
import { rollbackPlan, updatePlan, updateText } from '../../lib/app-update'
import { catalogVersion, filterChips, keptFilter, visibleApps, categoryLabel } from '../../lib/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

type Entry = Awaited<ReturnType<typeof trpc.catalog.list.query>>[number]

const apps = ref<Entry[]>([])
const loading = ref(true)
const search = ref('')
const category = ref<string>('All')
// The install wizard, or the detail page of one app (read from the live list,
// so its state follows the polling).
const selected = ref<Entry | null>(null)
const detailId = ref<string | null>(null)
const detail = computed(() => apps.value.find(a => a.id === detailId.value) ?? null)
// The App Store is only offered when installs can actually run.
const { check: checkDocker, ready: dockerReady } = useDockerStatus()

const chips = computed(() => filterChips(apps.value))
// A filter that no longer has apps (the last update applied) falls back to All
// for good: it must not come back by itself with the next update.
watch(chips, c => { category.value = keptFilter(c, category.value) })
const filtered = computed(() => visibleApps(apps.value, category.value, search.value))

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
  none:       { label: t('uis.store.AppStorePanel.notInstalled'), dot: '',                                      text: 'text-muted-foreground' },
  installing: { label: t('uis.store.AppStorePanel.installing'),   dot: 'bg-warning animate-pulse',   text: 'text-warning' },
  running:    { label: t('uis.store.AppStorePanel.running'),       dot: 'bg-success',                 text: 'text-success' },
  stopped:    { label: t('uis.store.AppStorePanel.stopped'),       dot: 'bg-muted-foreground',                  text: 'text-muted-foreground' },
  error:      { label: t('uis.store.AppStorePanel.error'),         dot: 'bg-primary',                  text: 'text-primary' },
}

function openWizard(a: Entry) { selected.value = a }
// Back from an app's page returns to the same place in the grid, focus included.
const scroller = ref<HTMLElement | null>(null)
let gridScroll = 0
function openDetail(a: Entry) {
  gridScroll = scroller.value?.scrollTop ?? 0
  detailId.value = a.id
}
async function closeDetail() {
  const id = detailId.value
  detailId.value = null
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = gridScroll
  scroller.value?.querySelector<HTMLElement>(`[data-card="${id}"]`)?.focus({ preventScroll: true })
}

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
        actionError.value = { id: a.id, message: `${opts.actionLabel} of ${inst.name} failed: ${result.error ?? t('uis.store.AppStorePanel.theAppCouldNotBe')}` }
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
  <div v-else ref="scroller" class="h-full overflow-y-auto p-4 sm:p-6">
    <div v-if="selected">
      <Button variant="ghost" size="sm" class="mb-3" @click="selected = null">{{ t('ui.store.AppStorePanel.back') }}</Button>
      <AppInstallWizard :app-id="selected.id" @installed="selected = null; load()" @close="selected = null" />
    </div>

    <AppStoreDetail
      v-else-if="detail"
      :app="detail"
      :state="STATE_META[cardState(detail)]"
      :busy="busy === detail.id"
      :error="actionError?.id === detail.id ? actionError.message : null"
      @back="closeDetail"
      @install="openWizard(detail)"
      @open="openApp(detail)"
      @update="runPlan(detail, 'app.update')"
      @rollback="runPlan(detail, 'app.rollback')"
    />

    <template v-else>
      <!-- Header -->
      <div class="flex flex-col items-stretch gap-3 mb-1 sm:flex-row sm:items-center sm:justify-between">
        <h2 class="text-lg font-semibold text-foreground">{{ t('ui.store.AppStorePanel.appStore') }}</h2>
        <Input v-model="search" :placeholder="t('ui.store.AppStorePanel.searchApps')" :aria-label="t('ui.store.AppStorePanel.searchApps2')" class="max-w-xs" />
      </div>
      <!-- Counts and filters only once the catalog is read: "0 apps" would be wrong. -->
      <p v-if="!loading" class="text-xs text-muted-foreground mb-4">
        {{ t('uip.store.AppStorePanel.appsInstalled', { p0: apps.length, p1: installedCount }) }}
      </p>

      <!-- Filters -->
      <ToggleGroup v-if="!loading" type="single" variant="outline" size="sm" :spacing="2" :aria-label="t('ui.store.AppStorePanel.category')"
        :model-value="category" @update:model-value="v => { if (v) category = v as typeof category }"
        class="mb-4 flex-wrap">
        <ToggleGroupItem v-for="c in chips" :key="c.key" :value="c.key"
          :class="['h-7 px-2.5 text-xs', c.key === 'Updates' && category !== c.key && 'text-warning']">
          {{ c.label }} <span class="opacity-60 tabular-nums">{{ c.count }}</span>
        </ToggleGroupItem>
      </ToggleGroup>

      <LoadingState v-if="loading" />

      <!-- No results -->
      <div v-else-if="filtered.length === 0" class="text-center py-16 text-muted-foreground">
        <p class="text-sm">{{ t('uip.store.AppStorePanel.noAppsMatch', { p0: search }) }}</p>
        <Button variant="ghost" size="sm" class="mt-2" @click="search = ''; category = 'All'">{{ t('ui.store.AppStorePanel.clearFilters') }}</Button>
      </div>

      <!-- Grid -->
      <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <!-- The whole card opens the app's page through its name button, stretched
             over the card; the action button sits above it. -->
        <div
          v-for="a in filtered" :key="a.id"
          class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden relative p-4 flex flex-col gap-3 transition-colors hover:border-input has-[[data-card]:focus-visible]:outline has-[[data-card]:focus-visible]:outline-2 has-[[data-card]:focus-visible]:outline-primary"
        >
          <!-- Identity -->
          <div class="flex gap-3 items-start min-w-0">
            <!-- eslint-disable-next-line vue/no-v-html -- `a.icon` is a bundled first-party brand logo from @app/app-catalog, not user input. -->
            <span class="w-10 h-10 shrink-0 grid place-items-center" v-html="a.icon" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <Button
                  type="button" :data-card="a.id" variant="link"
                  class="h-auto justify-start p-0 text-sm font-medium text-foreground truncate text-left hover:no-underline after:absolute after:inset-0 after:content-['']"
                  @click="openDetail(a)"
                >{{ a.name }}</Button>
                <span class="text-2xs uppercase tracking-caps text-muted-foreground shrink-0">{{ categoryLabel(a.category) }}</span>
              </div>
              <p class="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">{{ a.tagline }}</p>
            </div>
          </div>

          <!-- Update available (#26) -->
          <p v-if="a.installedApp?.update" class="text-xs text-warning">{{ updateText(a.installedApp.update) }}</p>
          <p v-if="actionError?.id === a.id" role="alert" class="status-text text-destructive break-words"><span class="status-tag">[ERR]</span> {{ actionError.message }}</p>

          <!-- State + one action -->
          <div class="flex items-center justify-between gap-2 mt-auto pt-1">
            <span class="inline-flex items-center gap-1.5 text-xs min-w-0" :class="STATE_META[cardState(a)].text">
              <span v-if="STATE_META[cardState(a)].dot" class="w-1.5 h-1.5 rounded-full shrink-0" :class="STATE_META[cardState(a)].dot" />
              {{ STATE_META[cardState(a)].label }}
              <span v-if="cardState(a) === 'none' && catalogVersion(a.image)" class="text-muted-foreground font-mono truncate">· {{ catalogVersion(a.image) }}</span>
            </span>

            <Button size="xs" v-if="cardState(a) === 'none'" class="relative z-10" :aria-label="`Install ${a.name}`" @click="openWizard(a)">{{ t('ui.store.AppStorePanel.install') }}</Button>
            <Button size="xs" v-else-if="a.installedApp?.update" class="relative z-10" :aria-label="`Update ${a.name}`" :disabled="busy === a.id" @click="runPlan(a, 'app.update')">{{ t('ui.store.AppStorePanel.update') }}</Button>
            <Button variant="outline" size="xs" v-else-if="a.installedApp?.webUrl || a.installedApp?.webPort != null" class="relative z-10" :aria-label="`Open ${a.name}`" @click="openApp(a)">{{ t('ui.store.AppStorePanel.open') }}</Button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
