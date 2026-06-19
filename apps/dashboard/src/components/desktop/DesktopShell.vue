<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useDesktop } from '../../lib/desktop'
import { useWallpaper } from '../../lib/wallpaper'
import type { Widget, WidgetType } from '../../lib/dashboard-widgets'
import DesktopWindow from './DesktopWindow.vue'
import DesktopWidgets from './DesktopWidgets.vue'
import WallpaperPicker from './WallpaperPicker.vue'

const { windows, clampToViewport } = useDesktop()
const { backgroundStyle } = useWallpaper()

const rootRef = ref<HTMLDivElement | null>(null)
const widgetsRef = ref<InstanceType<typeof DesktopWidgets> | null>(null)
const bounds = ref({ w: 0, h: 0 })
const showWallpaperPicker = ref(false)

type CtxMenu =
  | { kind: 'empty'; x: number; y: number }
  | { kind: 'widget'; x: number; y: number; widget: Widget }

const ctxMenu = ref<CtxMenu | null>(null)

function openCtx(menu: CtxMenu) {
  ctxMenu.value = { ...menu, x: Math.min(menu.x, window.innerWidth - 200), y: Math.min(menu.y, window.innerHeight - 240) }
}
function closeCtx() { ctxMenu.value = null }

// Fires for any right-click that reaches the root div without being stopped
// first — i.e. genuinely empty desktop space. Widget cards stop propagation
// themselves (see DesktopWidgets.vue) and emit contextmenu-widget instead;
// windows stop propagation in DesktopWindow.vue (Step 1 above).
function onContextmenuEmpty(e: MouseEvent) {
  openCtx({ kind: 'empty', x: e.clientX, y: e.clientY })
}
function onContextmenuWidget(widget: Widget, e: MouseEvent) {
  openCtx({ kind: 'widget', x: e.clientX, y: e.clientY, widget })
}

function addWidgetFromMenu(type: WidgetType) {
  widgetsRef.value?.addWidget(type)
  closeCtx()
}
function removeWidgetFromMenu(id: string) {
  widgetsRef.value?.removeWidget(id)
  closeCtx()
}
function toggleColsFromMenu(w: Widget) {
  widgetsRef.value?.toggleCols(w)
  closeCtx()
}
function openWallpaperPicker() {
  showWallpaperPicker.value = true
  closeCtx()
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
  <div
    ref="rootRef"
    class="relative w-full h-full overflow-hidden bg-[var(--c-bg)]"
    :style="backgroundStyle"
    @contextmenu.prevent="onContextmenuEmpty"
  >
    <DesktopWidgets
      ref="widgetsRef"
      @contextmenu-widget="onContextmenuWidget"
    />

    <DesktopWindow
      v-for="w in visibleWindows"
      :key="w.id"
      :win="w"
      :focused="isFocused(w.id)"
      :bounds="bounds"
    />

    <Teleport to="body">
      <template v-if="ctxMenu">
        <div class="fixed inset-0 z-40" @click="closeCtx" @contextmenu.prevent="closeCtx" />
        <div
          class="fixed z-50 bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl overflow-hidden py-1.5 min-w-[180px]"
          :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
          @click.stop
        >
          <template v-if="ctxMenu.kind === 'empty'">
            <button class="ctx-item" @click="openWallpaperPicker">Change wallpaper...</button>
            <div class="h-px bg-[var(--c-border-strong)] mx-2 my-1" />
            <p class="px-3 py-1 text-[10px] uppercase tracking-widest text-[var(--c-text-3)]">Add widget</p>
            <button
              v-for="cat in widgetsRef?.addableTypes ?? []" :key="cat.type"
              class="ctx-item"
              @click="addWidgetFromMenu(cat.type)"
            >
              {{ cat.label }}
            </button>
          </template>
          <template v-else>
            <button class="ctx-item" @click="toggleColsFromMenu(ctxMenu.widget)">
              {{ ctxMenu.widget.cols === 1 ? 'Expand' : 'Shrink' }}
            </button>
            <button class="ctx-item ctx-item-danger" @click="removeWidgetFromMenu(ctxMenu.widget.id)">Remove widget</button>
          </template>
        </div>
      </template>
    </Teleport>

    <WallpaperPicker v-if="showWallpaperPicker" @close="showWallpaperPicker = false" />
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.ctx-item {
  @apply w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-[var(--c-text-2)]
         hover:bg-[var(--c-hover)] transition-colors text-left;
}
.ctx-item-danger {
  color: var(--c-accent);
}
.ctx-item-danger:hover {
  background-color: var(--c-accent-subtle);
}
</style>
