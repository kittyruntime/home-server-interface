<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'

const emit = defineEmits<{ navigate: [target: 'secure'] }>()

const DISMISS_KEY = 'hsi.tlsBannerDismissed'
const show = ref(false)

function isDismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
}

function dismiss() {
  show.value = false
  try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* ignore */ }
}

onMounted(async () => {
  if (isDismissed()) return
  try {
    const s = await trpc.tls.status.query()
    show.value = s.mode === 'off'
  } catch { /* the banner is optional */ }
})
</script>

<template>
  <Transition name="ui-fade">
    <div
      v-if="show"
      class="panel-card relative mx-4 mt-4 border-[var(--c-border-strong)] bg-[var(--c-surface)] p-4 pr-12 sm:mx-6 sm:mt-5"
    >
      <button
        title="Dismiss"
        aria-label="Dismiss the HTTPS notice"
        class="absolute right-3 top-3 grid h-6 w-6 place-items-center rounded-md text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)] transition-colors"
        @click="dismiss"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
      <p class="text-sm text-[var(--c-text-2)]">This server is reached over plain HTTP. Turn HTTPS on to protect passwords and files on your network.</p>
      <button class="btn btn-primary btn-sm mt-3" @click="emit('navigate', 'secure')">Open Secure access</button>
    </div>
  </Transition>
</template>
