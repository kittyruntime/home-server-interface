import { ref, computed } from 'vue'
import { trpc } from './trpc'

const BASE_URL = import.meta.env.VITE_API_URL ? import.meta.env.VITE_API_URL.replace(/\/trpc$/, '') : ''

type WallpaperState =
  | { kind: 'none' }
  | { kind: 'color'; value: string }
  | { kind: 'image'; url: string }

const state = ref<WallpaperState>({ kind: 'none' })
let loaded = false

async function loadImageUrl(): Promise<string> {
  const { token } = await trpc.wallpaper.createImageToken.query()
  return `${BASE_URL}/files/wallpaper-image?token=${encodeURIComponent(token)}`
}

async function refresh() {
  const w = await trpc.wallpaper.get.query()
  if (w.kind === 'color') {
    state.value = { kind: 'color', value: w.value }
  } else if (w.kind === 'image') {
    state.value = { kind: 'image', url: await loadImageUrl() }
  } else {
    state.value = { kind: 'none' }
  }
}

export function useWallpaper() {
  if (!loaded) {
    loaded = true
    refresh().catch(() => { state.value = { kind: 'none' } })
  }

  const backgroundStyle = computed<Record<string, string>>(() => {
    if (state.value.kind === 'color') {
      const style: Record<string, string> = { backgroundColor: state.value.value }
      return style
    }
    if (state.value.kind === 'image') {
      const style: Record<string, string> = {
        backgroundImage: `url(${JSON.stringify(state.value.url)})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }
      return style
    }
    return {}
  })

  async function setColor(value: string) {
    await trpc.wallpaper.setColor.mutate({ value })
    state.value = { kind: 'color', value }
  }

  async function setImage(file: File) {
    const buf = await file.arrayBuffer()
    const data = btoa(String.fromCharCode(...new Uint8Array(buf)))
    await trpc.wallpaper.setImage.mutate({ data, mimeType: file.type })
    state.value = { kind: 'image', url: await loadImageUrl() }
  }

  async function clear() {
    await trpc.wallpaper.clear.mutate()
    state.value = { kind: 'none' }
  }

  return { backgroundStyle, setColor, setImage, clear }
}
