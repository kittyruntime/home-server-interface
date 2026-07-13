<script setup lang="ts">
import { computed, ref } from 'vue'
import { useDesktop, APP_LABEL, type AppId } from '../../lib/desktop'
import { useAuth } from '../../lib/auth'
import { useEscLayer } from '../../lib/escLayer'
import AppIcon from './AppIcon.vue'

const emit = defineEmits<{ close: [] }>()
const { openApp } = useDesktop()
const { isAdmin } = useAuth()

const visible = ref(true)
function requestClose() { visible.value = false }

const allApps: { id: AppId; adminOnly: boolean }[] = [
  { id: 'files',   adminOnly: false },
  { id: 'apps',    adminOnly: false },
  { id: 'storage', adminOnly: true },
  { id: 'store',   adminOnly: true },
  { id: 'monitor', adminOnly: true },
  { id: 'sharing', adminOnly: true },
  { id: 'settings', adminOnly: false },
]

const visibleApps = computed(() =>
  allApps.filter(a => !a.adminOnly || isAdmin.value).map(a => a.id)
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
        class="fixed inset-0 z-50 bg-[var(--c-bg)] flex items-center justify-center"
        style="--ui-dur: var(--dur-slow)"
        @click.self="requestClose"
      >
      <div class="grid grid-cols-4 gap-8 p-8">
        <button
          v-for="id in visibleApps"
          :key="id"
          @click="launch(id)"
          class="flex flex-col items-center gap-3 p-4 rounded-xl hover:bg-[var(--c-hover)] transition-colors"
        >
          <div class="w-16 h-16 rounded-xl bg-[var(--c-surface)] border border-[var(--c-border-strong)] flex items-center justify-center text-[var(--c-text-2)]">
            <AppIcon :app="id" :stroke-width="1.5" class="w-7 h-7" />
          </div>
          <span class="eyebrow">{{ APP_LABEL[id] }}</span>
        </button>
      </div>
      </div>
    </Transition>
  </Teleport>
</template>
