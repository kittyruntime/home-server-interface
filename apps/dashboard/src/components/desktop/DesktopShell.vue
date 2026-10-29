<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useDesktop } from '../../lib/desktop'
import { useWallpaper } from '../../lib/wallpaper'
import type { Widget, WidgetType } from '../../lib/dashboard-widgets'
import DesktopWindow from './DesktopWindow.vue'
import DesktopWidgets from './DesktopWidgets.vue'
import WallpaperPicker from './WallpaperPicker.vue'
import { ImageIcon, Maximize2Icon, Minimize2Icon, Trash2Icon } from '@lucide/vue'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu'

const { t } = useI18n()

const { windows, clampToViewport } = useDesktop()
const { backgroundStyle } = useWallpaper()

const rootRef = ref<HTMLDivElement | null>(null)
const widgetsRef = ref<InstanceType<typeof DesktopWidgets> | null>(null)
const bounds = ref({ w: 0, h: 0 })
const showWallpaperPicker = ref(false)

/* The desktop context menu opens on empty space or on a widget: a widget
   emits contextmenu-widget on its way up, the capture handler on the root
   clears it first. Windows stop the event, so they keep the browser's menu. */
const ctxWidget = ref<Widget | null>(null)

function onContextmenuWidget(widget: Widget) {
  ctxWidget.value = widget
}

function addWidgetFromMenu(type: WidgetType) {
  widgetsRef.value?.addWidget(type)
}
function removeWidgetFromMenu(id: string) {
  widgetsRef.value?.removeWidget(id)
}
function toggleColsFromMenu(w: Widget) {
  widgetsRef.value?.toggleCols(w)
}

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

const visibleWindows = computed(() =>
  windows.value.filter(w => !w.minimized).slice().sort((a, b) => a.zIndex - b.zIndex)
)

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
        class="relative isolate w-full h-full overflow-hidden bg-background"
        :style="backgroundStyle"
        @contextmenu.capture="ctxWidget = null"
      >
        <DesktopWidgets
          ref="widgetsRef"
          @contextmenu-widget="onContextmenuWidget"
        />

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
      <template v-if="ctxWidget">
        <ContextMenuItem @select="toggleColsFromMenu(ctxWidget)">
          <component :is="ctxWidget.cols === 1 ? Maximize2Icon : Minimize2Icon" />
          {{ ctxWidget.cols === 1 ? 'Expand' : 'Shrink' }}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" @select="removeWidgetFromMenu(ctxWidget.id)">
          <Trash2Icon />
          {{ t('ui.desktop.DesktopShell.removeWidget') }}
        </ContextMenuItem>
      </template>
      <template v-else>
        <ContextMenuItem @select="showWallpaperPicker = true">
          <ImageIcon />
          {{ t('ui.desktop.DesktopShell.changeWallpaper') }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuLabel class="text-2xs uppercase tracking-caps text-muted-foreground">{{ t('ui.desktop.DesktopShell.addWidget') }}</ContextMenuLabel>
        <ContextMenuItem
          v-for="cat in widgetsRef?.addableTypes ?? []" :key="cat.type"
          @select="addWidgetFromMenu(cat.type)"
        >
          {{ cat.label }}
        </ContextMenuItem>
      </template>
    </ContextMenuContent>
  </ContextMenu>
</template>
