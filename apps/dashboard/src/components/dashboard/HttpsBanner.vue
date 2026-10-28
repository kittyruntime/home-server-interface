<script setup lang="ts">
import { XIcon } from '@lucide/vue'
import { ref, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { Button } from '@/components/ui/button'

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
      class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden relative mx-4 mt-4 border-input bg-card p-4 pr-12 sm:mx-6 sm:mt-5"
    >
      <Button variant="ghost" size="icon-xs"
        tooltip="Dismiss"
        aria-label="Dismiss the HTTPS notice"
        class="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
        @click="dismiss"
      >
        <XIcon class="w-4 h-4" aria-hidden="true" />
      </Button>
      <p class="text-sm text-foreground/80">This server is reached over plain HTTP. Turn HTTPS on to protect passwords and files on your network.</p>
      <Button size="sm" class="mt-3" @click="emit('navigate', 'secure')">Open Secure access</Button>
    </div>
  </Transition>
</template>
