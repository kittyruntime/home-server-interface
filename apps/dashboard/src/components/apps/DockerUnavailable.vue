<script setup lang="ts">
import { computed } from 'vue'
import { useDockerStatus } from '../../lib/docker'

/* Full-panel notice shown instead of the apps list / App Store while Docker is
   not usable on the server. */
const { status, checking, check } = useDockerStatus()

const title = computed(() => {
  const s = status.value
  if (!s?.installed) return 'Docker is not installed'
  if (!s.running) return 'Docker is not running'
  return 'Docker Compose is missing'
})

const command = computed(() => {
  const s = status.value
  if (!s?.installed) return 'sudo apt install docker.io docker-compose-v2'
  if (!s.running) return 'sudo systemctl enable --now docker'
  return 'sudo apt install docker-compose-v2'
})
</script>

<template>
  <div class="flex h-full w-full items-center justify-center p-6">
    <div class="w-full max-w-lg rounded-xl border border-warning/30 bg-[var(--c-surface)] p-6 text-center">
      <div class="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-warning/10 text-warning">
        <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m0 3.75h.008M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>
        </svg>
      </div>
      <h2 class="text-base font-semibold text-[var(--c-text-1)]">{{ title }}</h2>
      <p class="mt-2 text-sm text-[var(--c-text-3)]">
        Apps and the App Store run on Docker. Run this on the server, then check again:
      </p>
      <code class="mt-3 block rounded-lg bg-[var(--c-surface-deep)] px-3 py-2 font-mono text-xs text-[var(--c-text-1)] select-all break-all">{{ command }}</code>
      <p v-if="status?.detail" class="mt-2 text-[11px] text-[var(--c-text-3)] break-words">{{ status.detail }}</p>
      <p class="mt-3 text-[11px] text-[var(--c-text-3)]">
        Other install options:
        <a href="https://docs.docker.com/engine/install/ubuntu/" target="_blank" rel="noopener" class="underline decoration-dotted underline-offset-2 hover:text-[var(--c-text-1)]">Docker's instructions for Ubuntu</a>
      </p>
      <button type="button" class="btn btn-primary btn-sm mt-4" :disabled="checking" @click="check">
        {{ checking ? 'Checking…' : 'Check again' }}
      </button>
    </div>
  </div>
</template>
