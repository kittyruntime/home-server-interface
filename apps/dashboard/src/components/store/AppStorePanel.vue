<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
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

async function load() {
  loading.value = true
  try { apps.value = await trpc.catalog.list.query() } finally { loading.value = false }
}
onMounted(load)
</script>

<template>
  <div class="h-full overflow-y-auto p-6">
    <div v-if="selected">
      <button class="btn btn-ghost btn-sm mb-3" @click="selected = null">← Back</button>
      <AppInstallWizard :app-id="selected.id" @installed="selected = null; load()" @close="selected = null" />
    </div>
    <template v-else>
      <div class="flex items-center justify-between gap-3 mb-4">
        <h2 class="text-base font-semibold text-[var(--c-text-1)]">App Store</h2>
        <input v-model="search" placeholder="Search apps…" class="ui-input max-w-xs" />
      </div>
      <div class="flex gap-2 mb-4 flex-wrap">
        <button v-for="c in categories" :key="c" @click="category = c"
          :class="['btn btn-xs', category === c ? 'btn-primary' : 'btn-outline']">{{ c }}</button>
      </div>
      <div v-if="loading" class="text-[var(--c-text-3)] text-sm">Loading…</div>
      <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <button v-for="a in filtered" :key="a.id" @click="selected = a"
          class="panel-card p-4 text-left flex gap-3 items-start hover:border-[var(--c-border-strong)]">
          <!-- eslint-disable-next-line vue/no-v-html -- `a.icon` is a bundled first-party SVG from @app/app-catalog, not user input. -->
          <span class="w-10 h-10 shrink-0 text-[var(--c-text-2)]" v-html="a.icon" />
          <span class="min-w-0">
            <span class="flex items-center gap-2">
              <span class="text-sm font-medium text-[var(--c-text-1)]">{{ a.name }}</span>
              <span v-if="a.installed" class="badge badge-muted">Installed</span>
            </span>
            <span class="block text-xs text-[var(--c-text-3)] mt-0.5 leading-relaxed">{{ a.tagline }}</span>
            <span class="block text-[10px] uppercase tracking-wide text-[var(--c-text-3)] mt-1">{{ a.category }}</span>
          </span>
        </button>
      </div>
    </template>
  </div>
</template>
