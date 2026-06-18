<script setup lang="ts">
import { ref, onUnmounted, watch } from 'vue'
import { useDesktop, APP_LABEL, APP_ICON_PATH, type DesktopWindow } from '../../lib/desktop'
import { useAuth } from '../../lib/auth'
import DashboardPanel from '../dashboard/DashboardPanel.vue'
import FileBrowserPanel from '../file-browser/FileBrowserPanel.vue'
import AppsPanel from '../apps/AppsPanel.vue'
import SettingsPanel from '../SettingsPanel.vue'

const props = defineProps<{
  win: DesktopWindow
  focused: boolean
  bounds: { w: number; h: number }
}>()

const { closeWindow, focusWindow, toggleMinimize, toggleMaximize, moveWindow, resizeWindow } = useDesktop()
const { isAdmin } = useAuth()

const appsPanelRef = ref<InstanceType<typeof AppsPanel> | null>(null)
const settingsPanelRef = ref<InstanceType<typeof SettingsPanel> | null>(null)

watch(() => props.win.focusNonce, () => {
  if (props.win.focusSection) settingsPanelRef.value?.focusOn(props.win.focusSection)
})

type DragState = { px: number; py: number; wx: number; wy: number }
type ResizeState = { px: number; py: number; ww: number; wh: number; wx: number; wy: number; edge: string }

let dragState: DragState | null = null
let resizeState: ResizeState | null = null

function startDrag(e: PointerEvent) {
  if (props.win.maximized) return
  focusWindow(props.win.id)
  dragState = { px: e.clientX, py: e.clientY, wx: props.win.x, wy: props.win.y }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
}

function onDragMove(e: PointerEvent) {
  if (!dragState) return
  const dx = e.clientX - dragState.px
  const dy = e.clientY - dragState.py
  const minVisible = 80
  const nx = Math.min(Math.max(dragState.wx + dx, -(props.win.w - minVisible)), Math.max(0, props.bounds.w - minVisible))
  const ny = Math.min(Math.max(dragState.wy + dy, 0), Math.max(0, props.bounds.h - 40))
  moveWindow(props.win.id, nx, ny)
}

function onDragEnd() {
  dragState = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
}

function startResize(e: PointerEvent, edge: string) {
  if (props.win.maximized) return
  focusWindow(props.win.id)
  resizeState = { px: e.clientX, py: e.clientY, ww: props.win.w, wh: props.win.h, wx: props.win.x, wy: props.win.y, edge }
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeEnd)
}

function onResizeMove(e: PointerEvent) {
  if (!resizeState) return
  const { px, py, ww, wh, wx, wy, edge } = resizeState
  const dx = e.clientX - px
  const dy = e.clientY - py
  let w = ww, h = wh, x = wx, y = wy
  if (edge.includes('e')) w = ww + dx
  if (edge.includes('s')) h = wh + dy
  if (edge.includes('w')) { w = ww - dx; x = wx + dx }
  if (edge.includes('n')) { h = wh - dy; y = wy + dy }
  if (w < 320) { if (edge.includes('w')) x = wx + (ww - 320); w = 320 }
  if (h < 240) { if (edge.includes('n')) y = wy + (wh - 240); h = 240 }
  resizeWindow(props.win.id, w, h)
  if (edge.includes('w') || edge.includes('n')) moveWindow(props.win.id, x, y)
}

function onResizeEnd() {
  resizeState = null
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
}

onUnmounted(() => {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
})

function onMaximizeClick() {
  toggleMaximize(props.win.id, props.bounds)
}
</script>

<template>
  <div
    class="absolute flex flex-col rounded-xl overflow-hidden bg-[var(--c-surface)] border"
    :class="focused ? 'border-[var(--c-accent)]' : 'border-[var(--c-border-strong)]'"
    :style="{ left: win.x + 'px', top: win.y + 'px', width: win.w + 'px', height: win.h + 'px', zIndex: win.zIndex }"
    @pointerdown="focusWindow(win.id)"
  >
    <div
      class="h-9 flex items-center justify-between px-3 border-b border-[var(--c-border)] bg-[var(--c-surface-alt)] flex-shrink-0 select-none cursor-default"
      @pointerdown="startDrag"
      @dblclick="onMaximizeClick"
    >
      <div class="flex items-center gap-2 min-w-0">
        <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" :d="APP_ICON_PATH[win.appId]"/>
        </svg>
        <span class="eyebrow truncate">{{ APP_LABEL[win.appId] }}</span>
      </div>
      <div class="flex items-center gap-3 shrink-0" @pointerdown.stop>
        <button
          v-if="win.appId === 'apps' && isAdmin"
          @click="appsPanelRef?.openNew()"
          title="New App"
          class="font-mono text-xs text-[var(--c-text-3)] hover:text-[var(--c-accent)] transition-colors"
        >[+]</button>
        <button @click="toggleMinimize(win.id)" title="Minimize" class="font-mono text-xs text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors">[_]</button>
        <button @click="onMaximizeClick" title="Maximize" class="font-mono text-xs text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors">[{{ win.maximized ? '❐' : '□' }}]</button>
        <button @click="closeWindow(win.id)" title="Close" class="font-mono text-xs text-[var(--c-text-3)] hover:text-[var(--c-accent)] transition-colors">[X]</button>
      </div>
    </div>

    <div class="flex-1 overflow-hidden">
      <DashboardPanel v-if="win.appId === 'dashboard'" class="h-full" />
      <FileBrowserPanel v-else-if="win.appId === 'files'" class="h-full" />
      <AppsPanel v-else-if="win.appId === 'apps'" ref="appsPanelRef" class="h-full" />
      <SettingsPanel v-else-if="win.appId === 'settings'" ref="settingsPanelRef" class="h-full" :focusSection="win.focusSection ?? null" />
    </div>

    <template v-if="!win.maximized">
      <div class="absolute top-0 left-1.5 right-1.5 h-1 cursor-ns-resize" @pointerdown.stop="startResize($event, 'n')" />
      <div class="absolute bottom-0 left-1.5 right-1.5 h-1 cursor-ns-resize" @pointerdown.stop="startResize($event, 's')" />
      <div class="absolute left-0 top-1.5 bottom-1.5 w-1 cursor-ew-resize" @pointerdown.stop="startResize($event, 'w')" />
      <div class="absolute right-0 top-1.5 bottom-1.5 w-1 cursor-ew-resize" @pointerdown.stop="startResize($event, 'e')" />
      <div class="absolute top-0 left-0 w-2 h-2 cursor-nwse-resize" @pointerdown.stop="startResize($event, 'nw')" />
      <div class="absolute top-0 right-0 w-2 h-2 cursor-nesw-resize" @pointerdown.stop="startResize($event, 'ne')" />
      <div class="absolute bottom-0 left-0 w-2 h-2 cursor-nesw-resize" @pointerdown.stop="startResize($event, 'sw')" />
      <div class="absolute bottom-0 right-0 w-2 h-2 cursor-nwse-resize" @pointerdown.stop="startResize($event, 'se')" />
    </template>
  </div>
</template>
