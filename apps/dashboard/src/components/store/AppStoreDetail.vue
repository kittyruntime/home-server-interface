<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { trpc } from '../../lib/trpc'
import { updateText } from '../../lib/app-update'
import { versionLabel } from '../../lib/store'

type Entry = Awaited<ReturnType<typeof trpc.catalog.list.query>>[number]

const props = defineProps<{
  app: Entry
  state: { label: string; dot: string; text: string }
  busy: boolean
  error: string | null
}>()
const emit = defineEmits<{ back: []; install: []; open: []; update: []; rollback: [] }>()

const inst = computed(() => props.app.installedApp)
const version = computed(() => versionLabel(props.app))
const canOpen = computed(() => !!inst.value && (inst.value.webUrl != null || inst.value.webPort != null))
const settings = computed(() => props.app.env.filter(e => e.prompt || e.required))

// The grid card that opened this page is gone: keyboard focus starts here.
const backButton = ref<HTMLButtonElement | null>(null)
onMounted(() => backButton.value?.focus())
</script>

<template>
  <div class="max-w-3xl space-y-4">
    <button ref="backButton" class="btn btn-ghost btn-sm" @click="emit('back')" @keydown.esc="emit('back')">← Back</button>

    <div class="panel-card p-5 space-y-5">
      <!-- Identity + main action -->
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start">
        <!-- eslint-disable-next-line vue/no-v-html -- `app.icon` is a bundled first-party brand logo from @app/app-catalog, not user input. -->
        <span class="w-14 h-14 shrink-0 grid place-items-center" v-html="app.icon" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <h3 class="text-base font-semibold text-[var(--c-text-1)]">{{ app.name }}</h3>
            <span class="text-2xs uppercase tracking-caps text-[var(--c-text-3)]">{{ app.category }}</span>
          </div>
          <p class="text-sm text-[var(--c-text-2)] mt-0.5">{{ app.tagline }}</p>
          <p class="text-xs mt-2 flex items-center gap-3 flex-wrap">
            <span class="inline-flex items-center gap-1.5" :class="state.text">
              <span v-if="state.dot" class="w-1.5 h-1.5 rounded-full" :class="state.dot" />
              {{ state.label }}
            </span>
            <span v-if="version" class="text-[var(--c-text-3)] font-mono">{{ version }}</span>
          </p>
        </div>
        <div class="flex items-center gap-1.5 flex-wrap shrink-0">
          <button v-if="!inst" class="btn btn-primary btn-sm" @click="emit('install')">Install</button>
          <button v-if="inst?.update" class="btn btn-primary btn-sm" :disabled="busy" @click="emit('update')">Update…</button>
          <button v-if="canOpen" class="btn btn-outline btn-sm" @click="emit('open')">Open ↗</button>
        </div>
      </div>

      <!-- Update / rollback -->
      <div v-if="inst?.update || inst?.rollbackTo" class="rounded-lg border border-[var(--c-border)] p-3 space-y-2">
        <p v-if="inst?.update" class="text-xs text-[var(--c-warning)] flex items-center gap-2 flex-wrap">
          <span>{{ updateText(inst.update) }}</span>
          <a v-if="app.changelog" :href="app.changelog" target="_blank" rel="noopener noreferrer" class="underline hover:text-[var(--c-text-1)]">What's new ↗</a>
        </p>
        <div v-if="inst?.rollbackTo" class="flex items-center justify-between gap-2 flex-wrap">
          <p class="text-xs text-[var(--c-text-3)]">The previous version, {{ inst.rollbackTo }}, is kept to roll back to.</p>
          <button class="btn btn-outline btn-xs" :disabled="busy" @click="emit('rollback')">Roll back to {{ inst.rollbackTo }}…</button>
        </div>
      </div>
      <p v-if="error" role="alert" class="status-text text-danger break-words"><span class="status-tag">[ERR]</span> {{ error }}</p>

      <!-- About -->
      <div class="space-y-2">
        <h4 class="eyebrow">About</h4>
        <p class="text-sm text-[var(--c-text-2)] leading-relaxed">{{ app.description }}</p>
        <p class="text-xs flex gap-4 flex-wrap">
          <a v-if="app.website" :href="app.website" target="_blank" rel="noopener noreferrer" class="underline text-[var(--c-text-3)] hover:text-[var(--c-text-1)]">Website ↗</a>
          <a v-if="app.changelog" :href="app.changelog" target="_blank" rel="noopener noreferrer" class="underline text-[var(--c-text-3)] hover:text-[var(--c-text-1)]">Release notes ↗</a>
        </p>
      </div>

      <!-- What the install asks for -->
      <div v-if="!inst && (app.ports.length || app.volumes.length || settings.length)" class="space-y-2">
        <h4 class="eyebrow">What it needs</h4>
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          <template v-for="p in app.ports" :key="`p-${p.container}-${p.protocol}`">
            <dt class="text-[var(--c-text-3)]">Port</dt>
            <dd class="text-[var(--c-text-2)] break-words">{{ p.label }} <span class="font-mono text-[var(--c-text-3)]">{{ p.container }}/{{ p.protocol }}</span></dd>
          </template>
          <template v-for="v in app.volumes" :key="`v-${v.target}`">
            <dt class="text-[var(--c-text-3)]">Folder</dt>
            <dd class="text-[var(--c-text-2)] break-words">{{ v.label }} <span class="font-mono text-[var(--c-text-3)]">{{ v.target }}</span></dd>
          </template>
          <template v-for="e in settings" :key="`e-${e.key}`">
            <dt class="text-[var(--c-text-3)]">Setting</dt>
            <dd class="text-[var(--c-text-2)] break-words">{{ e.prompt ?? e.key }}<span v-if="e.required" class="text-[var(--c-danger)]"> *</span></dd>
          </template>
        </dl>
      </div>

      <p class="text-2xs text-[var(--c-text-3)] font-mono break-all">{{ app.image }}</p>
    </div>
  </div>
</template>
