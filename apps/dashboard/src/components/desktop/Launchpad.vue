<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useDesktop, APP_LABEL, APP_ICON_PATH, type AppId } from '../../lib/desktop'

const emit = defineEmits<{ close: [] }>()
const { openApp } = useDesktop()

const APP_IDS: AppId[] = ['files', 'apps', 'settings']

function launch(id: AppId) {
  openApp(id)
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 bg-[var(--c-bg)] flex items-center justify-center"
      @click.self="emit('close')"
    >
      <div class="grid grid-cols-4 gap-8 p-8">
        <button
          v-for="id in APP_IDS"
          :key="id"
          @click="launch(id)"
          class="flex flex-col items-center gap-3 p-4 rounded-2xl hover:bg-[var(--c-hover)] transition-colors"
        >
          <div class="w-16 h-16 rounded-2xl bg-[var(--c-surface)] border border-[var(--c-border-strong)] flex items-center justify-center text-[var(--c-text-2)]">
            <svg class="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" :d="APP_ICON_PATH[id]"/>
            </svg>
          </div>
          <span class="eyebrow">{{ APP_LABEL[id] }}</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>
