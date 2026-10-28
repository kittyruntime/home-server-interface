<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { computed, ref } from 'vue'
import { useDesktop, APP_LABEL, type AppId } from '../../lib/desktop'
import { useAuth } from '../../lib/auth'
import { useAlerts } from '../../composables/useAlerts'
import { DialogContent, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import AppIcon from './AppIcon.vue'

const emit = defineEmits<{ close: [] }>()
const { openApp } = useDesktop()
const { isAdmin, hasCapability } = useAuth()
const { alerts, hasAlerts } = useAlerts()

/* Full-screen dialog: Escape and a click on the empty backdrop close it; the
   parent unmounts it on @close, once the leave animation has played. */
const visible = ref(true)
function requestClose() { visible.value = false }
function onClosed() { if (!visible.value) emit('close') }

const allApps: { id: AppId; adminOnly: boolean; capability?: string }[] = [
  { id: 'files',   adminOnly: false },
  { id: 'apps',    adminOnly: false },
  { id: 'storage', adminOnly: true, capability: 'storage' },
  { id: 'store',   adminOnly: true },
  { id: 'monitor', adminOnly: true },
  { id: 'sharing', adminOnly: true },
  { id: 'settings', adminOnly: false },
]

const visibleApps = computed(() =>
  allApps
    .filter(a => !a.adminOnly || isAdmin.value || (a.capability != null && hasCapability(a.capability).value))
    .map(a => a.id)
)

function launch(id: AppId) {
  openApp(id)
  requestClose()
}
</script>

<template>
  <DialogRoot :open="visible" @update:open="value => { if (!value) requestClose() }">
    <DialogPortal>
      <DialogContent
        :aria-describedby="undefined"
        class="fixed inset-0 z-50 bg-background flex items-center justify-center outline-none duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.97] data-[state=open]:zoom-in-[0.97]"
        @click.self="requestClose"
        @close-auto-focus="onClosed"
      >
        <DialogTitle class="sr-only">Launchpad</DialogTitle>
        <div class="grid grid-cols-4 gap-8 p-8">
          <Button
            v-for="id in visibleApps"
            :key="id"
            variant="ghost"
            @click="launch(id)"
            class="h-auto flex-col gap-3 p-4 rounded-xl font-normal whitespace-normal focus-visible:bg-accent"
          >
            <div class="relative size-16 rounded-xl bg-card border shadow-xs flex items-center justify-center text-foreground/80">
              <AppIcon :app="id" :stroke-width="1.5" class="size-7" />
              <span v-if="id === 'storage' && hasAlerts('storage.')"
                class="absolute top-1.5 right-1.5 size-2 rounded-full bg-destructive" />
              <span v-else-if="id === 'monitor' && alerts.length"
                class="absolute top-1.5 right-1.5 size-2 rounded-full bg-destructive" />
            </div>
            <span class="eyebrow">{{ APP_LABEL[id] }}</span>
          </Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
