<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useDesktop } from '../../lib/desktop'
import { shownWindows } from '../../lib/desktop-order'
import { useWallpaper } from '../../lib/wallpaper'
import { useBoards } from '../../lib/dashboard-boards'
import DesktopWindow from './DesktopWindow.vue'
import DesktopWidgets from './DesktopWidgets.vue'
import WallpaperPicker from './WallpaperPicker.vue'
import { CheckIcon, ImageIcon, LayoutGridIcon } from '@lucide/vue'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu'

const { t } = useI18n()

const { windows, clampToViewport } = useDesktop()
const { backgroundStyle } = useWallpaper()

const rootRef = ref<HTMLDivElement | null>(null)
const bounds = ref({ w: 0, h: 0 })
const showWallpaperPicker = ref(false)

/* The desktop's context menu: the wallpaper, editing the widgets and the
   board shown. Windows stop the event, so they keep the browser's menu. */
const { boards, active, editing, select } = useBoards()

function updateBounds() {
  if (!rootRef.value) return
  bounds.value = { w: rootRef.value.clientWidth, h: rootRef.value.clientHeight }
}

function onResize() {
  updateBounds()
  clampToViewport(bounds.value)
}

onMounted(() => {
  updateBounds()
  clampToViewport(bounds.value)
  window.addEventListener('resize', onResize)
})
onUnmounted(() => window.removeEventListener('resize', onResize))

const visibleWindows = computed(() => shownWindows(windows.value))

function isFocused(id: string): boolean {
  const visible = windows.value.filter(w => !w.minimized)
  if (visible.length === 0) return false
  const maxZ = Math.max(...visible.map(w => w.zIndex))
  const w = windows.value.find(w => w.id === id)
  return !!w && w.zIndex === maxZ && !w.minimized
}
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <div
        ref="rootRef"
        class="relative isolate w-full h-full overflow-hidden bg-base-100"
        :style="backgroundStyle"
      >
        <DesktopWidgets />

        <TransitionGroup name="ui-pop">
          <DesktopWindow
            v-for="w in visibleWindows"
            :key="w.id"
            :win="w"
            :focused="isFocused(w.id)"
            :bounds="bounds"
          />
        </TransitionGroup>

        <WallpaperPicker v-if="showWallpaperPicker" @close="showWallpaperPicker = false" />
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent class="min-w-[200px]">
      <ContextMenuItem @select="showWallpaperPicker = true">
        <ImageIcon />
        {{ t('ui.desktop.DesktopShell.changeWallpaper') }}
      </ContextMenuItem>
      <ContextMenuItem @select="editing = !editing">
        <component :is="editing ? CheckIcon : LayoutGridIcon" />
        {{ editing ? t('widgets.edit.done') : t('widgets.edit.desktop') }}
      </ContextMenuItem>
      <template v-if="boards.length > 1">
        <ContextMenuSeparator />
        <ContextMenuLabel class="text-2xs uppercase tracking-caps text-base-content/60">{{ t('widgets.boards.label') }}</ContextMenuLabel>
        <ContextMenuItem v-for="(b, i) in boards" :key="b.id" @select="select(i)">
          <CheckIcon :class="i === active ? '' : 'invisible'" />
          {{ b.name }}
        </ContextMenuItem>
      </template>
    </ContextMenuContent>
  </ContextMenu>
</template>
