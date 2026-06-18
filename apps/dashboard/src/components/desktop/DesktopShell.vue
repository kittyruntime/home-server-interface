<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useDesktop } from '../../lib/desktop'
import DesktopWindow from './DesktopWindow.vue'

const { windows, clampToViewport } = useDesktop()

const rootRef = ref<HTMLDivElement | null>(null)
const bounds = ref({ w: 0, h: 0 })

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
  <div ref="rootRef" class="relative w-full h-full overflow-hidden bg-[var(--c-bg)]">
    <DesktopWindow
      v-for="w in visibleWindows"
      :key="w.id"
      :win="w"
      :focused="isFocused(w.id)"
      :bounds="bounds"
    />
  </div>
</template>
