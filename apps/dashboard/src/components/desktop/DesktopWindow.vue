<script setup lang="ts">
import { ref, computed, onUnmounted, onMounted, watch } from 'vue'
import { useDesktop, APP_LABEL, APP_ICON_PATH, type DesktopWindow } from '../../lib/desktop'
import { useAuth } from '../../lib/auth'
import { downloadUrl } from '../../lib/file-url'
import FileBrowserPanel from '../file-browser/FileBrowserPanel.vue'
import AppsPanel from '../apps/AppsPanel.vue'
import SettingsPanel from '../SettingsPanel.vue'
import StoragePanel from '../storage/StoragePanel.vue'
import MonitorPanel from '../monitor/MonitorPanel.vue'
import SharingPanel from '../sharing/SharingPanel.vue'
import FilePreviewBody from '../file-browser/preview/FilePreviewBody.vue'

const props = defineProps<{
  win: DesktopWindow
  focused: boolean
  bounds: { w: number; h: number }
}>()

const { closeWindow, focusWindow, toggleMinimize, toggleMaximize, moveWindow, resizeWindow, setDirty } = useDesktop()
const { isAdmin } = useAuth()

const appsPanelRef = ref<InstanceType<typeof AppsPanel> | null>(null)
const settingsPanelRef = ref<InstanceType<typeof SettingsPanel> | null>(null)
const filePreviewRef = ref<{ save: () => void } | null>(null)

const filePreviewExt = computed(() => {
  const name = props.win.filePreview?.name ?? ''
  return name.includes('.') ? name.split('.').pop()!.toUpperCase() : ''
})

const downloadHref = ref<string | null>(null)
onMounted(async () => {
  if (props.win.appId !== 'file-preview') return
  try {
    downloadHref.value = await downloadUrl(props.win.filePreview!.path)
  } catch { /* link stays inert until a token is available */ }
})

watch(() => props.win.focusNonce, () => {
  if (props.win.focusSection) settingsPanelRef.value?.focusOn(props.win.focusSection)
})

function onCloseClick() {
  if (props.win.appId === 'file-preview' && props.win.dirty && !confirm('Discard unsaved changes?')) return
  closeWindow(props.win.id)
}

function onMinimizeClick() {
  if (props.win.appId === 'file-preview' && props.win.dirty && !confirm('Discard unsaved changes?')) return
  toggleMinimize(props.win.id)
}

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
    @contextmenu.stop
  >
    <div
      class="h-9 flex items-center justify-between px-3 border-b border-[var(--c-border)] bg-[var(--c-surface-alt)] flex-shrink-0 select-none cursor-default"
      @pointerdown="startDrag"
      @dblclick="onMaximizeClick"
    >
      <div v-if="win.appId === 'file-preview'" class="flex items-center gap-2 min-w-0">
        <span class="text-xs text-[var(--c-text-1)] truncate" :title="win.filePreview?.name">{{ win.filePreview?.name }}</span>
        <span v-if="filePreviewExt" class="badge badge-muted shrink-0">{{ filePreviewExt }}</span>
        <span v-if="win.dirty" class="status-text text-[var(--c-warning)] shrink-0 text-[10px]">[UNSAVED]</span>
      </div>
      <div v-else class="flex items-center gap-2 min-w-0">
        <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" :d="APP_ICON_PATH[win.appId]"/>
        </svg>
        <span class="eyebrow truncate">{{ APP_LABEL[win.appId] }}</span>
      </div>
      <div class="flex items-center gap-1 shrink-0" @pointerdown.stop>
        <button
          v-if="win.appId === 'apps' && isAdmin"
          @click="appsPanelRef?.openNew()"
          title="New App"
          class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
        </button>
        <button
          v-if="win.appId === 'file-preview' && win.dirty"
          @click="filePreviewRef?.save()"
          title="Save"
          class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
          </svg>
        </button>
        <a
          v-if="win.appId === 'file-preview'"
          :href="downloadHref ?? undefined"
          :download="win.filePreview!.name"
          title="Download"
          class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
          </svg>
        </a>
        <button @click="onMinimizeClick" title="Minimize" class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14"/>
          </svg>
        </button>
        <button @click="onMaximizeClick" :title="win.maximized ? 'Restore' : 'Maximize'" class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
          <svg v-if="win.maximized" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 9V5a1 1 0 011-1h9a1 1 0 011 1v9a1 1 0 01-1 1h-4M5 9h9a1 1 0 011 1v9a1 1 0 01-1 1H5a1 1 0 01-1-1v-9a1 1 0 011-1z"/>
          </svg>
          <svg v-else class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 5h14v14H5z"/>
          </svg>
        </button>
        <button @click="onCloseClick" title="Close" class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-accent)] hover:bg-[var(--c-accent-subtle)] transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-hidden">
      <FileBrowserPanel v-if="win.appId === 'files'" class="h-full" :desktopWindow="true" />
      <AppsPanel v-else-if="win.appId === 'apps'" ref="appsPanelRef" class="h-full" />
      <SettingsPanel v-else-if="win.appId === 'settings'" ref="settingsPanelRef" class="h-full" :focusSection="win.focusSection ?? null" />
      <StoragePanel v-else-if="win.appId === 'storage'" class="h-full" />
      <MonitorPanel v-else-if="win.appId === 'monitor'" class="h-full" />
      <SharingPanel v-else-if="win.appId === 'sharing'" class="h-full" />
      <FilePreviewBody v-else-if="win.appId === 'file-preview'" ref="filePreviewRef" :entry="win.filePreview!" class="h-full" @dirty="setDirty(win.id, $event)" />
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
