<script setup lang="ts">
import { useDesktop, APP_LABEL, APP_ICON_PATH } from '../../lib/desktop'

const { windows, focusWindow, toggleMinimize } = useDesktop()

defineEmits<{ openLaunchpad: [] }>()

function isFocused(id: string): boolean {
  if (windows.value.length === 0) return false
  const maxZ = Math.max(...windows.value.map(w => w.zIndex))
  const w = windows.value.find(w => w.id === id)
  return !!w && w.zIndex === maxZ && !w.minimized
}

function onIconClick(id: string) {
  const w = windows.value.find(w => w.id === id)
  if (!w) return
  if (w.minimized) {
    focusWindow(id)
  } else if (isFocused(id)) {
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
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"/>
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
          :title="APP_LABEL[w.appId]"
          :class="[
            'w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150',
            w.minimized ? 'opacity-40' : '',
            isFocused(w.id)
              ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
              : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]',
          ]"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" :d="APP_ICON_PATH[w.appId]"/>
          </svg>
        </button>
      </div>
    </nav>
  </div>
</template>
