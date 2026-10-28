<script setup lang="ts">
import { ref, nextTick, useId } from 'vue'
import LoadingState from '../ui/LoadingState.vue'
import { nextTab } from '../../lib/tabs'

// The page of one storage object (#40): a header with the object's name, its
// chips, its key figure and its actions, then Overview / Structure / Activity.

export type ObjectTab = 'overview' | 'structure' | 'activity'

defineProps<{
  title: string
  subtitle?: string
  loading: boolean
  error?: string
  /** The object is not there any more: what to say, and where to go back. */
  gone?: { text: string; back: string }
}>()
const emit = defineEmits<{ back: [] }>()
const tab = defineModel<ObjectTab>('tab', { default: 'overview' })

const TABS: { id: ObjectTab; label: string }[] = [
  { id: 'overview',  label: 'Overview' },
  { id: 'structure', label: 'Structure' },
  { id: 'activity',  label: 'Activity' },
]
const tabEls = ref<HTMLButtonElement[]>([])
const uid = useId()

async function onKey(e: KeyboardEvent) {
  const next = nextTab(TABS.map(t => t.id), tab.value, e.key) as ObjectTab | null
  if (!next) return
  e.preventDefault()
  tab.value = next
  await nextTick()
  tabEls.value[TABS.findIndex(t => t.id === next)]?.focus()
}
</script>

<template>
  <div>
    <LoadingState v-if="loading" />
    <p v-else-if="error" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>
    <div v-else-if="gone" class="rounded-xl border border-border bg-card px-4 py-8 text-center text-sm text-foreground/80">
      {{ gone.text }}
      <button class="ml-1 text-foreground underline decoration-input underline-offset-2 hover:decoration-foreground" @click="emit('back')">{{ gone.back }}</button>
    </div>

    <template v-else>
      <header class="flex flex-col @2xl/content:flex-row @2xl/content:items-start @2xl/content:justify-between gap-3 mb-4">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <h2 class="text-lg font-semibold text-foreground truncate">{{ title }}</h2>
            <slot name="chips" />
          </div>
          <p v-if="subtitle" class="mt-0.5 font-mono text-xs text-muted-foreground truncate">{{ subtitle }}</p>
          <div class="mt-3"><slot name="figure" /></div>
        </div>
        <div class="flex items-center gap-2 shrink-0"><slot name="actions" /></div>
      </header>

      <div role="tablist" aria-label="Sections of this page" class="flex gap-5 border-b border-border mb-4 overflow-x-auto" @keydown="onKey">
        <button
          v-for="t in TABS" :key="t.id"
          :ref="el => { if (el) tabEls[TABS.indexOf(t)] = el as HTMLButtonElement }"
          role="tab"
          :id="`${uid}-tab-${t.id}`"
          :aria-selected="tab === t.id"
          :aria-controls="tab === t.id ? `${uid}-panel-${t.id}` : undefined"
          :tabindex="tab === t.id ? 0 : -1"
          :class="['pb-2 -mb-px text-sm whitespace-nowrap border-b-2 transition-colors',
            tab === t.id ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground']"
          @click="tab = t.id"
        >{{ t.label }}</button>
      </div>

      <section :id="`${uid}-panel-${tab}`" role="tabpanel" :aria-labelledby="`${uid}-tab-${tab}`">
        <slot v-if="tab === 'overview'" name="overview" />
        <slot v-else-if="tab === 'structure'" name="structure" />
        <slot v-else name="activity" />
      </section>
    </template>
  </div>
</template>
