<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { useDesktop, APP_LABEL } from '../../lib/desktop'
import { useAlerts } from '../../composables/useAlerts'
import AppIcon from './AppIcon.vue'

const { t } = useI18n()

const { windows, focusWindow, toggleMinimize } = useDesktop()
const { hasAlerts } = useAlerts()

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
    if (w.dirty && !confirm(t('uis.desktop.Dock.discardUnsavedChanges'))) return
    toggleMinimize(id)
  } else {
    focusWindow(id)
  }
}
</script>

<template>
  <div class="flex flex-col items-center w-16 py-4 h-full">
    <Button
      size="icon-sm"
      :tooltip="t('ui.desktop.Dock.launchpad')"
      :aria-label="t('ui.desktop.Dock.launchpad')"
      class="relative mb-5 rounded-lg select-none"
      @click="$emit('openLaunchpad')"
    >
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="8" cy="8" r="2.2"/>
        <circle cx="16" cy="8" r="2.2"/>
        <circle cx="8" cy="16" r="2.2"/>
        <circle cx="16" cy="16" r="2.2"/>
      </svg>
      <span v-if="hasAlerts('storage.')"
        class="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-destructive" />
    </Button>

    <div class="w-8 border-t border-border mb-3" />

    <nav class="flex flex-col items-stretch gap-1 flex-1 w-full overflow-y-auto">
      <div v-for="w in windows" :key="w.id" class="relative flex justify-center py-0.5">
        <span
          v-if="isFocused(w.id)"
          class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 bg-primary rounded-r-full"
        />
        <Button
          variant="ghost"
          size="icon"
          @click="onIconClick(w.id)"
          :tooltip="w.appId === 'file-preview' ? (w.filePreview?.name ?? APP_LABEL[w.appId]) : APP_LABEL[w.appId]"
          :aria-label="w.appId === 'file-preview' ? (w.filePreview?.name ?? APP_LABEL[w.appId]) : APP_LABEL[w.appId]"
          :class="[
            'size-10 rounded-xl transition-all duration-150',
            w.minimized ? 'opacity-40' : '',
            isFocused(w.id)
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          ]"
        >
          <AppIcon :app="w.appId" class="w-5 h-5" />
        </Button>
      </div>
    </nav>
  </div>
</template>
