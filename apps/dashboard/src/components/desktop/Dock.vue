<script setup lang="ts">
import { useDesktop, APP_LABEL } from '../../lib/desktop'
import AppIcon from './AppIcon.vue'

const { windows, focusWindow, toggleMinimize } = useDesktop()

defineEmits<{ openLaunchpad: [] }>()

function isFocused(id: string): boolean {
  const visible = windows.value.filter(w => !w.minimized)
  if (visible.length === 0) return false
  const maxZ = Math.max(...visible.map(w => w.zIndex))
  const w = windows.value.find(w => w.id === id)
  return !!w && w.zIndex === maxZ && !w.minimized
}

function onIconClick(id: string) {
  const w = windows.value.find(w => w.id === id)
  if (!w) return
  if (w.minimized) {
    focusWindow(id)
  } else if (isFocused(id)) {
    if (w.appId === 'file-preview' && w.dirty && !confirm('Discard unsaved changes?')) return
    toggleMinimize(id)
  } else {
    focusWindow(id)
  }
}
</script>

<template>
  <div class="flex flex-col items-center w-16 py-4 h-full">
    <button
      @click="$emit('openLaunchpad')"
      title="Launchpad"
      class="w-8 h-8 rounded-lg bg-[var(--c-accent)] flex items-center justify-center text-[var(--c-accent-fg)] mb-5 select-none"
    >
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="8" cy="8" r="2.2"/>
        <circle cx="16" cy="8" r="2.2"/>
        <circle cx="8" cy="16" r="2.2"/>
        <circle cx="16" cy="16" r="2.2"/>
      </svg>
    </button>

    <div class="w-8 border-t border-[var(--c-border)] mb-3" />

    <nav class="flex flex-col items-stretch gap-1 flex-1 w-full overflow-y-auto">
      <div v-for="w in windows" :key="w.id" class="relative flex justify-center py-0.5">
        <span
          v-if="isFocused(w.id)"
          class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 bg-[var(--c-accent)] rounded-r-full"
        />
        <button
          @click="onIconClick(w.id)"
          :title="w.appId === 'file-preview' ? (w.filePreview?.name ?? APP_LABEL[w.appId]) : APP_LABEL[w.appId]"
          :class="[
            'w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150',
            w.minimized ? 'opacity-40' : '',
            isFocused(w.id)
              ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
              : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]',
          ]"
        >
          <AppIcon :app="w.appId" class="w-5 h-5" />
        </button>
      </div>
    </nav>
  </div>
</template>
