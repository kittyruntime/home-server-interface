<script setup lang="ts">
import AppTile from './AppTile.vue'
import SearchInput from '../ui/SearchInput.vue'
import { ExternalLinkIcon } from '@lucide/vue'
import CatalogSource from './CatalogSource.vue'
import { useI18n } from 'vue-i18n'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import AppStoreSkeleton from './AppStoreSkeleton.vue'
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { trpc } from '../../lib/trpc'
import AppInstallWizard from './AppInstallWizard.vue'
import AppStoreDetail from './AppStoreDetail.vue'
import DockerUnavailable from '../apps/DockerUnavailable.vue'
import { useDockerStatus } from '../../lib/docker'
import { applyPlanned } from '../../lib/plan'
import { pollJobResult } from '../../lib/jobs'
import { rollbackPlan, updatePlan, updateText } from '../../lib/app-update'
import { filterChips, isNew, keptFilter, visibleApps, categoryLabel, type StoreOrder } from '../../lib/store'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Button } from '@/components/ui/button'
import { usePoll } from '../../lib/poll'

const { t } = useI18n()

type Entry = Awaited<ReturnType<typeof trpc.catalog.list.query>>[number]

const apps = ref<Entry[]>([])
const loading = ref(true)
const search = ref('')
const category = ref<string>('All')
const order = ref<StoreOrder>('default')
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
const filtered = computed(() => visibleApps(apps.value, category.value, search.value, order.value))

const installedCount = computed(() => apps.value.filter(a => a.installed).length)

// The browsing view (everything, no search, default order) is arranged in
// shelves: one app to discover, then updates, installed apps and the rest.
// A filter, a search or another order shows one plain list.
const browsing = computed(() => category.value === 'All' && !search.value.trim() && order.value === 'default')
const featured = computed(() => {
  if (!browsing.value) return null
  const fresh = apps.value.filter(a => !a.installed && isNew(a))
  const pool = fresh.length ? fresh : apps.value.filter(a => !a.installed)
  return [...pool].sort((a, b) => (b.added ?? '').localeCompare(a.added ?? ''))[0] ?? null
})
const sections = computed(() => {
  if (!browsing.value) return [{ key: 'list', title: null as string | null, apps: filtered.value }]
  // Browsing shows what there is to get; the installed apps have their own
  // view next to the store, and come back here through a category or a search.
  const updates = filtered.value.filter(a => a.installedApp?.update)
  const available = filtered.value.filter(a => !a.installed)
  return [
    { key: 'updates', title: t('ui.store.AppStorePanel.sectionUpdates'), apps: updates },
    { key: 'available', title: t('ui.store.AppStorePanel.sectionAvailable'), apps: available },
  ].filter(g => g.apps.length)
})
const canOpen = (a: Entry) => !!a.installedApp && (a.installedApp.webUrl != null || a.installedApp.webPort != null)

// An install lands on the app's page, with its first steps (#26).
function installed(id: string) {
  selected.value = null
  detailId.value = id
  void load()
}

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
  none:       { label: t('uis.store.AppStorePanel.notInstalled'), dot: '',                                      text: 'text-base-content/70' },
  installing: { label: t('uis.store.AppStorePanel.installing'),   dot: 'bg-warning animate-pulse',   text: 'text-warning' },
  running:    { label: t('uis.store.AppStorePanel.running'),       dot: 'bg-success',                 text: 'text-success' },
  stopped:    { label: t('uis.store.AppStorePanel.stopped'),       dot: 'bg-base-content/70',                  text: 'text-base-content/70' },
  error:      { label: t('uis.store.AppStorePanel.error'),         dot: 'bg-primary',                  text: 'text-primary' },
}

// Back from an app's page returns to the same place in the grid, focus included.
const scroller = ref<HTMLElement | null>(null)
let gridScroll = 0
function openWizard(a: Entry) {
  // Installed from its card: the app's page opens afterwards, and Back from it
  // returns here.
  if (!detailId.value) gridScroll = scroller.value?.scrollTop ?? 0
  selected.value = a
}
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

onMounted(() => {
  void checkDocker()
  load()
})
// Light polling so install → running (and stop/error) transitions show without
// a manual reload. Paused while the wizard is open (grid isn't visible then).
usePoll(() => !selected.value && refresh(), 6000, { immediate: false })
</script>

<template>
  <DockerUnavailable v-if="!dockerReady()" />
  <div v-else ref="scroller" class="h-full overflow-y-auto">
    <div class="mx-auto w-full max-w-5xl px-4 py-5 sm:px-8 sm:py-8">
      <div v-if="selected">
        <Button variant="ghost" size="sm" class="mb-3 -ml-2" @click="selected = null">{{ t('ui.store.AppStorePanel.back') }}</Button>
        <AppInstallWizard :app-id="selected.id" @installed="installed(selected.id)" @close="selected = null" />
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
        <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div class="min-w-0">
            <h2 class="text-2xl font-semibold tracking-tight text-base-content">{{ t('ui.store.AppStorePanel.appStore') }}</h2>
            <!-- Counts only once the catalog is read: "0 apps" would be wrong. -->
            <p v-if="!loading" class="mt-1 text-sm text-base-content/70 tabular-nums">
              {{ t('uip.store.AppStorePanel.appsInstalled', { p0: apps.length, p1: installedCount }) }}
            </p>
          </div>
          <div class="flex items-center gap-2 sm:w-96">
            <SearchInput v-model="search" :placeholder="t('ui.store.AppStorePanel.searchApps')" :aria-label="t('ui.store.AppStorePanel.searchApps2')" class="min-w-0 flex-1" />
            <NativeSelect
              :model-value="order"
              wrapper-class="w-auto shrink-0"
              class="w-auto"
              :aria-label="t('ui.store.AppStorePanel.sortApps')"
              @update:model-value="order = $event as StoreOrder"
            >
              <NativeSelectOption value="default">{{ t('ui.store.AppStorePanel.installedFirst') }}</NativeSelectOption>
              <NativeSelectOption value="name">{{ t('ui.store.AppStorePanel.byName') }}</NativeSelectOption>
              <NativeSelectOption value="added">{{ t('ui.store.AppStorePanel.recentlyAdded') }}</NativeSelectOption>
            </NativeSelect>
          </div>
        </header>

        <div v-if="!loading" class="content-in mt-5 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <ToggleGroup type="single" variant="tabs" size="sm" :aria-label="t('ui.store.AppStorePanel.category')"
            :model-value="category" @update:model-value="v => { if (v) category = v as typeof category }"
            class="flex-nowrap">
            <ToggleGroupItem v-for="c in chips" :key="c.key" :value="c.key" class="shrink-0 gap-1.5 whitespace-nowrap">
              {{ c.label }}<span class="tabular-nums" :class="c.key === 'Updates' ? 'text-warning' : 'opacity-60'">{{ c.count }}</span>
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        <AppStoreSkeleton v-if="loading && !apps.length" />

        <div v-else-if="filtered.length === 0" class="py-20 text-center">
          <p class="text-sm text-base-content/70">{{ t('uip.store.AppStorePanel.noAppsMatch', { p0: search }) }}</p>
          <Button variant="ghost" size="sm" class="mt-2" @click="search = ''; category = 'All'">{{ t('ui.store.AppStorePanel.clearFilters') }}</Button>
        </div>

        <div v-else class="content-in">
          <!-- One app to discover: the newest the server does not run yet. -->
          <section v-if="featured" class="feature relative mt-6 flex flex-col gap-5 overflow-hidden rounded-box bg-base-200 p-6 sm:flex-row sm:items-center sm:gap-7 sm:p-8"
            :aria-label="featured.name">
            <AppTile :svg="featured.icon" :name="featured.name" size="xl" />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="text-xl font-semibold tracking-tight text-base-content">{{ featured.name }}</h3>
                <span v-if="isNew(featured)" class="badge badge-sm badge-primary badge-soft">{{ t('ui.store.AppStorePanel.new') }}</span>
              </div>
              <p class="mt-1 text-sm text-base-content/80">{{ featured.tagline }}</p>
              <p class="mt-2 max-w-prose text-sm leading-relaxed text-base-content/70 line-clamp-2">{{ featured.description }}</p>
              <div class="mt-4 flex items-center gap-2">
                <Button size="sm" class="min-w-24" :aria-label="`${t('ui.store.AppStorePanel.install')} ${featured.name}`" @click="openWizard(featured)">{{ t('ui.store.AppStorePanel.install') }}</Button>
                <Button variant="ghost" size="sm" @click="openDetail(featured)">{{ t('ui.store.AppStorePanel.learnMore') }}</Button>
              </div>
            </div>
          </section>

          <section v-for="g in sections" :key="g.key" class="mt-8" :aria-label="g.title ?? undefined">
            <h3 v-if="g.title" class="mb-1 text-lg font-semibold tracking-tight text-base-content">
              {{ g.title }}
              <span class="ml-1 text-sm font-normal text-base-content/60 tabular-nums">{{ g.apps.length }}</span>
            </h3>
            <ul class="grid grid-cols-1 gap-x-10 lg:grid-cols-2">
              <!-- The row opens the app's page through its name, stretched over
                   the row; the action button sits above it. -->
              <li
                v-for="a in g.apps" :key="a.id"
                class="row relative flex items-center gap-4 py-3.5"
              >
                <AppTile :svg="a.icon" :name="a.name" />
                <div class="min-w-0 flex-1">
                  <button type="button" :data-card="a.id"
                    class="block max-w-full truncate text-left text-sm font-semibold text-base-content outline-none after:absolute after:inset-0 after:rounded-field after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-primary"
                    @click="openDetail(a)">{{ a.name }}</button>
                  <p class="truncate text-xs text-base-content/70">{{ a.tagline }}</p>
                  <p class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
                    <template v-if="a.installedApp?.update">
                      <span class="truncate text-warning">{{ updateText(a.installedApp.update) }}</span>
                    </template>
                    <template v-else-if="cardState(a) !== 'none'">
                      <span class="size-1.5 shrink-0 rounded-full" :class="STATE_META[cardState(a)].dot" />
                      <span :class="STATE_META[cardState(a)].text">{{ STATE_META[cardState(a)].label }}</span>
                    </template>
                    <template v-else>
                      <span class="text-base-content/60">{{ categoryLabel(a.category) }}</span>
                      <span v-if="isNew(a)" class="text-primary">· {{ t('ui.store.AppStorePanel.new') }}</span>
                    </template>
                  </p>
                  <p v-if="actionError?.id === a.id" role="alert" class="status-text mt-1 text-error break-words"><span class="status-tag">[ERR]</span> {{ actionError.message }}</p>
                </div>
                <div class="relative z-10 shrink-0">
                  <Button v-if="cardState(a) === 'none'" size="sm" class="btn-soft min-w-20" :aria-label="`${t('ui.store.AppStorePanel.install')} ${a.name}`" @click="openWizard(a)">{{ t('ui.store.AppStorePanel.install') }}</Button>
                  <Button v-else-if="a.installedApp?.update" size="sm" class="btn-soft min-w-20" :aria-label="`${t('ui.store.AppStorePanel.updateShort')} ${a.name}`" :disabled="busy === a.id" @click="runPlan(a, 'app.update')">{{ t('ui.store.AppStorePanel.updateShort') }}</Button>
                  <Button v-else-if="canOpen(a)" variant="secondary" size="sm" class="min-w-20" :aria-label="`${t('ui.store.AppStorePanel.openShort')} ${a.name}`" @click="openApp(a)">
                    {{ t('ui.store.AppStorePanel.openShort') }}<ExternalLinkIcon class="size-3.5 opacity-60" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            </ul>
          </section>

          <CatalogSource class="mt-10 border-t border-base-300 pt-4" @updated="refresh" />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Hairlines between rows, from the text edge as in a grouped list; none above
   the first row of each column. */
.row + .row::before {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  left: 3.75rem;
  border-top: 1px solid color-mix(in oklab, var(--color-base-content) 10%, transparent);
}
@media (min-width: 64rem) {
  .row:nth-child(2)::before { display: none; }
}
.feature {
  background:
    radial-gradient(120% 140% at 0% 0%, color-mix(in oklab, var(--color-primary) 10%, transparent), transparent 60%),
    var(--color-base-200);
}
</style>
