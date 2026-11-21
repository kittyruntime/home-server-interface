<script setup lang="ts">
import AppTile from './AppTile.vue'
import { useI18n } from 'vue-i18n'
import type { Component } from 'vue'
import { computed, onMounted, ref } from 'vue'
import { BookOpenIcon, ChevronLeftIcon, CodeIcon, ExternalLinkIcon, GlobeIcon, HardDriveIcon, KeyRoundIcon, NetworkIcon, PowerIcon, ScrollTextIcon } from '@lucide/vue'
import type { trpc } from '../../lib/trpc'
import { updateText } from '../../lib/app-update'
import { appPermissions, type PermissionKind } from '../../lib/app-permissions'
import { isNew, catalogVersion, categoryLabel } from '../../lib/store'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

type Entry = Awaited<ReturnType<typeof trpc.catalog.list.query>>[number]

const props = defineProps<{
  app: Entry
  state: { label: string; dot: string; text: string }
  busy: boolean
  error: string | null
}>()
const emit = defineEmits<{ back: []; install: []; open: []; update: []; rollback: [] }>()

const inst = computed(() => props.app.installedApp)
// The version that runs, or the one the catalog would install.
const version = computed(() => catalogVersion(inst.value?.image ?? props.app.image))
const canOpen = computed(() => !!inst.value && (inst.value.webUrl != null || inst.value.webPort != null))
const permissions = computed(() => appPermissions(props.app))

const PERMISSION_ICON: Record<PermissionKind, Component> = {
  Storage: HardDriveIcon,
  Network: NetworkIcon,
  Secret: KeyRoundIcon,
  Startup: PowerIcon,
}

const links = computed(() => ([
  { href: props.app.website, label: t('ui.store.AppStoreDetail.websiteLink'), icon: GlobeIcon },
  { href: props.app.docs, label: t('ui.store.AppStoreDetail.documentationLink'), icon: BookOpenIcon },
  { href: props.app.source, label: t('ui.store.AppStoreDetail.sourceCodeLink'), icon: CodeIcon },
  { href: props.app.changelog, label: t('ui.store.AppStoreDetail.releaseNotesLink'), icon: ScrollTextIcon },
] as { href?: string | null; label: string; icon: Component }[]).filter((l): l is { href: string; label: string; icon: Component } => !!l.href))

// The facts strip under the title: short values, one per column.
const facts = computed(() => [
  { label: t('ui.store.AppStoreDetail.factCategory'), value: categoryLabel(props.app.category), mono: false },
  { label: t('ui.store.AppStoreDetail.factVersion'), value: version.value ?? '-', mono: true },
  { label: t('ui.store.AppStoreDetail.license'), value: props.app.license || '-', mono: false },
  { label: t('ui.store.AppStoreDetail.factPort'), value: props.app.webUiPort != null ? String(inst.value?.webPort ?? props.app.webUiPort) : '-', mono: true },
])

// The list row that opened this page is gone: keyboard focus starts here.
const backButton = ref<InstanceType<typeof Button> | null>(null)
onMounted(() => (backButton.value?.$el as HTMLElement | undefined)?.focus())
</script>

<template>
  <article class="max-w-3xl">
    <Button variant="ghost" size="sm" ref="backButton" class="-ml-2 text-primary" @click="emit('back')" @keydown.esc="emit('back')">
      <ChevronLeftIcon aria-hidden="true" />{{ t('ui.store.AppStoreDetail.backToStore') }}
    </Button>

    <!-- Identity and the main action -->
    <header class="mt-5 flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-7">
      <AppTile :svg="app.icon" :name="app.name" size="xl" />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-2xl font-semibold tracking-tight text-base-content">{{ app.name }}</h2>
          <span v-if="isNew(app)" class="badge badge-sm badge-primary badge-soft">{{ t('ui.store.AppStoreDetail.new') }}</span>
        </div>
        <p class="mt-1 text-base text-base-content/70">{{ app.tagline }}</p>
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <Button v-if="!inst" size="sm" class="min-w-24" @click="emit('install')">{{ t('ui.store.AppStoreDetail.install') }}</Button>
          <Button v-if="inst?.update" size="sm" class="min-w-24" :disabled="busy" @click="emit('update')">{{ t('ui.store.AppStoreDetail.updateShort') }}</Button>
          <Button v-if="canOpen" variant="secondary" size="sm" class="min-w-24" @click="emit('open')">
            {{ t('ui.store.AppStoreDetail.openShort') }}<ExternalLinkIcon class="size-3.5 opacity-60" aria-hidden="true" />
          </Button>
          <span v-if="inst" class="ml-1 inline-flex items-center gap-1.5 text-xs" :class="state.text">
            <span v-if="state.dot" class="size-1.5 rounded-full" :class="state.dot" />{{ state.label }}
          </span>
        </div>
      </div>
    </header>

    <dl class="mt-7 grid grid-cols-2 border-y border-base-300 sm:grid-cols-4">
      <div v-for="(f, i) in facts" :key="f.label"
        class="px-4 py-3 text-center"
        :class="[i % 2 === 1 && 'border-l border-base-300', i >= 2 && 'max-sm:border-t sm:border-l border-base-300']">
        <dt class="text-2xs uppercase tracking-caps text-base-content/60">{{ f.label }}</dt>
        <dd class="mt-1 truncate text-sm font-medium text-base-content" :class="f.mono && 'font-mono'">{{ f.value }}</dd>
      </div>
    </dl>

    <p v-if="error" role="alert" class="status-text mt-5 text-error break-words"><span class="status-tag">[ERR]</span> {{ error }}</p>

    <!-- Update and rollback (#26) -->
    <section v-if="inst?.update || inst?.rollbackTo" class="mt-8" aria-labelledby="news-heading">
      <h3 id="news-heading" class="text-lg font-semibold tracking-tight text-base-content">{{ t('ui.store.AppStoreDetail.whatsNewTitle') }}</h3>
      <div class="mt-2 space-y-3 text-sm">
        <p v-if="inst?.update" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="text-warning">{{ updateText(inst.update) }}</span>
          <a v-if="app.changelog" :href="app.changelog" target="_blank" rel="noopener noreferrer" class="link link-primary link-hover inline-flex items-center gap-1">
            {{ t('ui.store.AppStoreDetail.releaseNotesLink') }}<ExternalLinkIcon class="size-3.5" aria-hidden="true" />
          </a>
        </p>
        <div v-if="inst?.rollbackTo" class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-base-content/70">{{ t('uip.store.AppStoreDetail.thePreviousVersionIsKept', { p0: inst.rollbackTo }) }}</p>
          <Button variant="ghost" size="sm" :disabled="busy" @click="emit('rollback')">{{ t('uip.store.AppStoreDetail.rollBackTo', { p0: inst.rollbackTo }) }}</Button>
        </div>
      </div>
    </section>

    <section class="mt-8" aria-labelledby="about-heading">
      <h3 id="about-heading" class="text-lg font-semibold tracking-tight text-base-content">{{ t('ui.store.AppStoreDetail.about') }}</h3>
      <p class="mt-2 max-w-prose text-sm leading-relaxed text-base-content/80">{{ app.description }}</p>
      <p v-if="app.services?.length" class="mt-2 text-sm text-base-content/70">
        {{ t('ui.store.AppStoreDetail.installsWith') }}
        <template v-for="(sc, i) in app.services" :key="sc.name">
          <span v-if="i">, </span>
          <span class="text-base-content/80">{{ sc.label }}</span>
          <span class="font-mono text-xs"> ({{ sc.image }})</span>
        </template>
      </p>
    </section>

    <!-- First steps (#26): read before installing, and the page an install lands on. -->
    <section v-if="app.postInstall?.length" class="mt-8" aria-labelledby="start-heading">
      <h3 id="start-heading" class="text-lg font-semibold tracking-tight text-base-content">{{ inst ? t('ui.store.AppStoreDetail.gettingStarted') : t('ui.store.AppStoreDetail.afterInstalling') }}</h3>
      <ol class="mt-3 space-y-3">
        <li v-for="(step, i) in app.postInstall" :key="i" class="flex gap-3 text-sm leading-relaxed text-base-content/80">
          <span class="grid size-6 shrink-0 place-items-center rounded-full bg-base-200 text-xs font-semibold tabular-nums text-base-content/70" aria-hidden="true">{{ i + 1 }}</span>
          <span class="pt-0.5">{{ step }}</span>
        </li>
      </ol>
    </section>

    <section v-if="permissions.length" class="mt-8" aria-labelledby="perm-heading">
      <h3 id="perm-heading" class="text-lg font-semibold tracking-tight text-base-content">{{ t('ui.store.AppStoreDetail.permissions') }}</h3>
      <ul class="mt-3 divide-y divide-base-300 overflow-hidden rounded-box border border-base-300 bg-base-100">
        <li v-for="p in permissions" :key="`${p.kind}-${p.detail}`" class="flex items-start gap-3 px-4 py-3">
          <span class="grid size-8 shrink-0 place-items-center rounded-field bg-base-200 text-base-content/70">
            <component :is="PERMISSION_ICON[p.kind]" class="size-4" aria-hidden="true" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-sm text-base-content">
              {{ p.title }}
              <span v-if="p.note" class="badge badge-ghost badge-sm ml-1 align-middle">{{ p.note }}</span>
            </p>
            <p class="mt-0.5 break-words font-mono text-xs text-base-content/70">{{ p.detail }}</p>
          </div>
          <span class="shrink-0 pt-0.5 text-xs text-base-content/60">{{ t(`ui.store.AppStoreDetail.kind${p.kind}`) }}</span>
        </li>
      </ul>
    </section>

    <section v-if="links.length" class="mt-8" aria-labelledby="links-heading">
      <h3 id="links-heading" class="text-lg font-semibold tracking-tight text-base-content">{{ t('ui.store.AppStoreDetail.links') }}</h3>
      <ul class="mt-3 divide-y divide-base-300 overflow-hidden rounded-box border border-base-300 bg-base-100">
        <li v-for="l in links" :key="l.href">
          <a :href="l.href" target="_blank" rel="noopener noreferrer"
            class="flex items-center gap-3 px-4 py-3 text-sm text-base-content transition-colors hover:bg-base-200 focus-visible:bg-base-200 focus-visible:outline-none">
            <component :is="l.icon" class="size-4 text-base-content/60" aria-hidden="true" />
            <span class="flex-1">{{ l.label }}</span>
            <ExternalLinkIcon class="size-3.5 text-base-content/50" aria-hidden="true" />
          </a>
        </li>
      </ul>
    </section>

    <p class="mt-8 break-all font-mono text-2xs text-base-content/60">{{ app.image }}</p>
  </article>
</template>
