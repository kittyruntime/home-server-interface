import { ref } from 'vue'

export type AppId = 'dashboard' | 'files' | 'apps' | 'settings'
export type SettingsSection = 'profile' | 'users' | 'places' | 'roles' | 'updates'

export interface DesktopWindow {
  id: string
  appId: AppId
  x: number
  y: number
  w: number
  h: number
  minimized: boolean
  maximized: boolean
  prevRect?: { x: number; y: number; w: number; h: number }
  zIndex: number
  focusSection?: SettingsSection
  focusNonce?: number
}

export const APP_LABEL: Record<AppId, string> = {
  dashboard: 'Overview',
  files: 'Files',
  apps: 'Apps',
  settings: 'Settings',
}

export const APP_ICON_PATH: Record<AppId, string> = {
  dashboard: 'M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z',
  files: 'M3 7a2 2 0 012-2h3.586a1 1 0 01.707.293L11 7h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  apps: 'M5 12H19M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01',
  settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
}

const STORAGE_KEY = 'desktop'
const MODE_KEY = 'desktopMode'
const MULTI_INSTANCE = new Set<AppId>(['files'])
const MIN_W = 320
const MIN_H = 240
const MIN_VISIBLE = 80

const DEFAULT_SIZE: Record<AppId, { w: number; h: number }> = {
  dashboard: { w: 720, h: 520 },
  files: { w: 860, h: 560 },
  apps: { w: 760, h: 540 },
  settings: { w: 860, h: 560 },
}

function loadWindows(): DesktopWindow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as DesktopWindow[]
    }
  } catch { /* ignore */ }
  return []
}

function saveWindows(ws: DesktopWindow[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ws))
}

function loadDesktopMode(): boolean {
  return localStorage.getItem(MODE_KEY) === '1'
}

function saveDesktopMode(v: boolean) {
  localStorage.setItem(MODE_KEY, v ? '1' : '0')
}

const windows = ref<DesktopWindow[]>(loadWindows())
const desktopMode = ref<boolean>(loadDesktopMode())

function persist() {
  saveWindows(windows.value)
}

function nextZIndex(): number {
  return windows.value.reduce((max, w) => Math.max(max, w.zIndex), 0) + 1
}

function cascadeOffset(): { x: number; y: number } {
  const step = (windows.value.length * 24) % 240
  return { x: 48 + step, y: 48 + step }
}

function clampWindow(w: DesktopWindow, bounds: { w: number; h: number }) {
  if (w.maximized) {
    w.x = 0
    w.y = 0
    w.w = bounds.w
    w.h = bounds.h
    return
  }
  w.w = Math.min(w.w, Math.max(bounds.w, MIN_W))
  w.h = Math.min(w.h, Math.max(bounds.h, MIN_H))
  w.x = Math.min(Math.max(w.x, -(w.w - MIN_VISIBLE)), Math.max(0, bounds.w - MIN_VISIBLE))
  w.y = Math.min(Math.max(w.y, 0), Math.max(0, bounds.h - MIN_VISIBLE))
}

export function useDesktop() {
  function openApp(appId: AppId, focusSection?: SettingsSection) {
    if (!MULTI_INSTANCE.has(appId)) {
      const existing = windows.value.find(w => w.appId === appId)
      if (existing) {
        if (focusSection !== undefined) {
          existing.focusSection = focusSection
          existing.focusNonce = (existing.focusNonce ?? 0) + 1
        }
        focusWindow(existing.id)
        return
      }
    }
    const size = DEFAULT_SIZE[appId]
    const { x, y } = cascadeOffset()
    const win: DesktopWindow = {
      id: crypto.randomUUID(),
      appId,
      x,
      y,
      w: size.w,
      h: size.h,
      minimized: false,
      maximized: false,
      zIndex: nextZIndex(),
      focusSection,
    }
    windows.value.push(win)
    persist()
  }

  function closeWindow(id: string) {
    windows.value = windows.value.filter(w => w.id !== id)
    persist()
  }

  function focusWindow(id: string) {
    const w = windows.value.find(w => w.id === id)
    if (!w) return
    w.minimized = false
    w.zIndex = nextZIndex()
    persist()
  }

  function toggleMinimize(id: string) {
    const w = windows.value.find(w => w.id === id)
    if (!w) return
    w.minimized = !w.minimized
    persist()
  }

  function toggleMaximize(id: string, bounds: { w: number; h: number }) {
    const w = windows.value.find(w => w.id === id)
    if (!w) return
    if (w.maximized) {
      if (w.prevRect) {
        w.x = w.prevRect.x
        w.y = w.prevRect.y
        w.w = w.prevRect.w
        w.h = w.prevRect.h
      }
      w.maximized = false
      w.prevRect = undefined
    } else {
      w.prevRect = { x: w.x, y: w.y, w: w.w, h: w.h }
      w.x = 0
      w.y = 0
      w.w = bounds.w
      w.h = bounds.h
      w.maximized = true
    }
    persist()
  }

  function moveWindow(id: string, x: number, y: number) {
    const w = windows.value.find(w => w.id === id)
    if (!w) return
    w.x = x
    w.y = y
    persist()
  }

  function resizeWindow(id: string, w: number, h: number) {
    const win = windows.value.find(win => win.id === id)
    if (!win) return
    win.w = Math.max(MIN_W, w)
    win.h = Math.max(MIN_H, h)
    persist()
  }

  function clampToViewport(bounds: { w: number; h: number }) {
    for (const w of windows.value) clampWindow(w, bounds)
    persist()
  }

  function setDesktopMode(v: boolean) {
    desktopMode.value = v
    saveDesktopMode(v)
  }

  return {
    windows,
    desktopMode,
    setDesktopMode,
    openApp,
    closeWindow,
    focusWindow,
    toggleMinimize,
    toggleMaximize,
    moveWindow,
    resizeWindow,
    clampToViewport,
  }
}
