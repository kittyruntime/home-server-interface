<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{ navigate: [target: 'places' | 'store' | 'backups'] }>()

const DISMISS_KEY = 'getting-started-dismissed'
const dismissed = ref(localStorage.getItem(DISMISS_KEY) === '1')

function dismiss() {
  dismissed.value = true
  localStorage.setItem(DISMISS_KEY, '1')
}

const steps: Array<{ target: 'places' | 'store' | 'backups'; title: string; description: string }> = [
  { target: 'places', title: 'Add a Place', description: 'Map a server folder so you can browse, share and manage it.' },
  { target: 'store', title: 'Install an app', description: 'Deploy a self-hosted app from the curated App Store.' },
  { target: 'backups', title: 'Set up a backup plan', description: 'Keep versions of your data, or a copy elsewhere, on a schedule.' },
]
</script>

<template>
  <Transition name="ui-fade">
    <div
      v-if="!dismissed"
      class="panel-card relative mx-4 mt-4 border-[var(--c-border-strong)] bg-[var(--c-surface)] p-4 sm:mx-6 sm:mt-5"
    >
      <button
        title="Dismiss"
        aria-label="Dismiss getting started"
        class="absolute right-3 top-3 grid h-6 w-6 place-items-center rounded-md text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)] transition-colors"
        @click="dismiss"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      <h3 class="text-sm font-semibold text-[var(--c-text-1)]">Getting started</h3>
      <p class="mt-0.5 text-xs text-[var(--c-text-3)]">A few things worth setting up first.</p>

      <div class="mt-3 grid gap-2 sm:grid-cols-3">
        <button
          v-for="s in steps" :key="s.target"
          class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface-alt)] p-3 text-left transition-colors hover:border-[var(--c-border-strong)] hover:bg-[var(--c-hover)]"
          @click="emit('navigate', s.target)"
        >
          <p class="text-xs font-semibold text-[var(--c-text-1)]">{{ s.title }}</p>
          <p class="mt-1 text-xs text-[var(--c-text-3)]">{{ s.description }}</p>
        </button>
      </div>
    </div>
  </Transition>
</template>
