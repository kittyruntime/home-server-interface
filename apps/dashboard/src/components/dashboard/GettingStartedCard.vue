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
      class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden relative mx-4 mt-4 border-input bg-card p-4 sm:mx-6 sm:mt-5"
    >
      <button
        title="Dismiss"
        aria-label="Dismiss getting started"
        class="absolute right-3 top-3 grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        @click="dismiss"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      <h3 class="text-sm font-semibold text-foreground">Getting started</h3>
      <p class="mt-0.5 text-xs text-muted-foreground">A few things worth setting up first.</p>

      <div class="mt-3 grid gap-2 sm:grid-cols-3">
        <button
          v-for="s in steps" :key="s.target"
          class="rounded-xl border border-border bg-muted p-3 text-left transition-colors hover:border-input hover:bg-accent"
          @click="emit('navigate', s.target)"
        >
          <p class="text-xs font-semibold text-foreground">{{ s.title }}</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ s.description }}</p>
        </button>
      </div>
    </div>
  </Transition>
</template>
