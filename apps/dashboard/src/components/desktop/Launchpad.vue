<script setup lang="ts">
import { computed, ref } from 'vue'
import { useDesktop, APP_LABEL, type AppId } from '../../lib/desktop'
import { useAuth } from '../../lib/auth'
import { useAlerts } from '../../composables/useAlerts'
import { useEscLayer } from '../../lib/escLayer'
import AppIcon from './AppIcon.vue'

const emit = defineEmits<{ close: [] }>()
const { openApp } = useDesktop()
const { isAdmin, hasCapability } = useAuth()
const { alerts, hasAlerts } = useAlerts()

const visible = ref(true)
function requestClose() { visible.value = false }

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

useEscLayer(requestClose)
</script>

<template>
  <Teleport to="body">
    <Transition name="ui-pop" appear @after-leave="emit('close')">
      <div
        v-if="visible"
        class="fixed inset-0 z-50 bg-background flex items-center justify-center"
        style="--ui-dur: var(--dur-slow)"
        @click.self="requestClose"
      >
      <div class="grid grid-cols-4 gap-8 p-8">
        <button
          v-for="id in visibleApps"
          :key="id"
          @click="launch(id)"
          class="flex flex-col items-center gap-3 p-4 rounded-xl hover:bg-accent transition-colors"
        >
          <div class="relative w-16 h-16 rounded-xl bg-card border border-input flex items-center justify-center text-foreground/80">
            <AppIcon :app="id" :stroke-width="1.5" class="w-7 h-7" />
            <span v-if="id === 'storage' && hasAlerts('storage.')"
              class="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-destructive" />
            <span v-else-if="id === 'monitor' && alerts.length"
              class="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-destructive" />
          </div>
          <span class="eyebrow">{{ APP_LABEL[id] }}</span>
        </button>
      </div>
      </div>
    </Transition>
  </Teleport>
</template>
