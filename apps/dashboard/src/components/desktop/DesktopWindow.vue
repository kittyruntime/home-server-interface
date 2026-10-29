<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { CheckIcon, CopyIcon, DownloadIcon, MinusIcon, PlusIcon, SquareIcon, XIcon } from '@lucide/vue'
import { ref, computed, onUnmounted, onMounted, provide, watch, defineAsyncComponent } from 'vue'
import { useDesktop, APP_LABEL, type DesktopWindow } from '../../lib/desktop'
import { modalHostKey } from '../../lib/modal-host'
import AppIcon from './AppIcon.vue'
import { useAuth } from '../../lib/auth'
import { useConfirm } from '../../lib/confirm'
import { downloadUrl } from '../../lib/file-url'
import FileBrowserPanel from '../file-browser/FileBrowserPanel.vue'
import FilePreviewBody from '../file-browser/preview/FilePreviewBody.vue'
// Type-only imports keep the async chunks split while typing the template refs.
import type AppsPanelT from '../apps/AppsPanel.vue'
import type SettingsPanelT from '../SettingsPanel.vue'
import { Badge } from '@/components/ui/badge'

const { t } = useI18n()

// Split the heavier per-app panels into their own chunks: only the window's
// active app is ever mounted, so they need not weigh down the initial bundle.
const AppsPanel = defineAsyncComponent(() => import('../apps/AppsPanel.vue'))
const SettingsPanel = defineAsyncComponent(() => import('../SettingsPanel.vue'))
const StoragePanel = defineAsyncComponent(() => import('../storage/StoragePanel.vue'))
const AppStorePanel = defineAsyncComponent(() => import('../store/AppStorePanel.vue'))
const MonitorPanel = defineAsyncComponent(() => import('../monitor/MonitorPanel.vue'))
const SharingPanel = defineAsyncComponent(() => import('../sharing/SharingPanel.vue'))

const props = defineProps<{
  win: DesktopWindow
  focused: boolean
  bounds: { w: number; h: number }
}>()

const { closeWindow, focusWindow, toggleMinimize, toggleMaximize, moveWindow, resizeWindow, setDirty } = useDesktop()
const { isAdmin } = useAuth()

/* Modals opened by the app inside this window render within its body
   instead of covering the whole screen. */
const bodyEl = ref<HTMLElement | null>(null)
provide(modalHostKey, bodyEl)

const appsPanelRef = ref<InstanceType<typeof AppsPanelT> | null>(null)
const settingsPanelRef = ref<InstanceType<typeof SettingsPanelT> | null>(null)
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

const { confirm } = useConfirm()

// A minimized window is unmounted too: both lose unsaved changes.
async function discardChanges(): Promise<boolean> {
  return !props.win.dirty || await confirm('Discard unsaved changes?', { danger: true, confirmLabel: 'Discard' })
}

async function onCloseClick() {
  if (await discardChanges()) closeWindow(props.win.id)
}

async function onMinimizeClick() {
  if (await discardChanges()) toggleMinimize(props.win.id)
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
    class="absolute flex flex-col rounded-xl overflow-hidden bg-card border"
    :class="focused ? 'border-primary' : 'border-input'"
    :style="{ left: win.x + 'px', top: win.y + 'px', width: win.w + 'px', height: win.h + 'px', zIndex: win.zIndex }"
    @pointerdown="focusWindow(win.id)"
    @contextmenu.stop
  >
    <div
      class="h-9 flex items-center justify-between px-3 border-b border-border bg-muted flex-shrink-0 select-none cursor-default"
      @pointerdown="startDrag"
      @dblclick="onMaximizeClick"
    >
      <div v-if="win.appId === 'file-preview'" class="flex items-center gap-2 min-w-0">
        <span class="text-xs text-foreground truncate" :title="win.filePreview?.name">{{ win.filePreview?.name }}</span>
        <Badge variant="secondary" v-if="filePreviewExt" class="shrink-0">{{ filePreviewExt }}</Badge>
        <span v-if="win.dirty" class="status-text text-warning shrink-0 text-2xs">[UNSAVED]</span>
      </div>
      <div v-else class="flex items-center gap-2 min-w-0">
        <AppIcon :app="win.appId" :stroke-width="2" class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span class="eyebrow truncate">{{ APP_LABEL[win.appId] }}</span>
      </div>
      <div class="flex items-center gap-1 shrink-0" @pointerdown.stop>
        <Button variant="ghost" size="icon-xs"
          v-if="win.appId === 'apps' && isAdmin"
          @click="appsPanelRef?.openNew()"
          :tooltip="t('ui.desktop.DesktopWindow.newApp')" :aria-label="t('ui.desktop.DesktopWindow.newApp')"
          class="text-muted-foreground hover:text-foreground"
        >
          <PlusIcon class="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-xs"
          v-if="win.appId === 'file-preview' && win.dirty"
          @click="filePreviewRef?.save()"
          :tooltip="t('ui.desktop.DesktopWindow.save')" :aria-label="t('ui.desktop.DesktopWindow.save')"
          class="text-muted-foreground hover:text-foreground"
        >
          <CheckIcon class="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
        <Button
          as="a"
          variant="ghost"
          size="icon-xs"
          v-if="win.appId === 'file-preview'"
          :href="downloadHref ?? undefined"
          :download="win.filePreview!.name"
          :tooltip="t('ui.desktop.DesktopWindow.download')"
          :aria-label="t('ui.desktop.DesktopWindow.download')"
          class="text-muted-foreground"
        >
          <DownloadIcon class="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-xs" @click="onMinimizeClick" :tooltip="t('ui.desktop.DesktopWindow.minimize')" :aria-label="t('ui.desktop.DesktopWindow.minimize')" class="text-muted-foreground hover:text-foreground">
          <MinusIcon class="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-xs" @click="onMaximizeClick" :tooltip="win.maximized ? 'Restore' : 'Maximize'" :aria-label="win.maximized ? 'Restore' : 'Maximize'" class="text-muted-foreground hover:text-foreground">
          <CopyIcon v-if="win.maximized" class="w-3.5 h-3.5" aria-hidden="true" />
          <SquareIcon v-else class="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon-xs" @click="onCloseClick" :tooltip="t('ui.desktop.DesktopWindow.close')" :aria-label="t('ui.desktop.DesktopWindow.close')" class="text-muted-foreground hover:text-primary hover:bg-primary/10">
          <XIcon class="w-3.5 h-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>

    <div ref="bodyEl" class="relative flex-1 overflow-hidden">
      <FileBrowserPanel v-if="win.appId === 'files'" class="h-full" :desktopWindow="true" />
      <AppsPanel v-else-if="win.appId === 'apps'" ref="appsPanelRef" class="h-full" />
      <SettingsPanel v-else-if="win.appId === 'settings'" ref="settingsPanelRef" class="h-full" :focusSection="win.focusSection ?? null" />
      <StoragePanel v-else-if="win.appId === 'storage'" class="h-full" @dirty="setDirty(win.id, $event)" />
      <AppStorePanel v-else-if="win.appId === 'store'" class="h-full" />
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
