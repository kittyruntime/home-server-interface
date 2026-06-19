<script setup lang="ts">
import { ref } from 'vue'
import Modal from '../ui/Modal.vue'
import { useWallpaper } from '../../lib/wallpaper'

const emit = defineEmits<{ close: [] }>()
const { setColor, setImage, clear } = useWallpaper()

const SWATCHES = ['#d71921', '#f97316', '#3b82f6', '#22c55e', '#a855f7', '#1a1a1a', '#666666', '#f5f5f5']

const customColor = ref('#d71921')
const error = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

async function pickColor(value: string) {
  error.value = null
  try {
    await setColor(value)
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to set color'
  }
}

async function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  error.value = null
  try {
    await setImage(file)
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to upload image'
  } finally {
    ;(e.target as HTMLInputElement).value = ''
  }
}

async function reset() {
  error.value = null
  try {
    await clear()
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to reset wallpaper'
  }
}
</script>

<template>
  <Modal panel-class="w-full max-w-sm" @close="emit('close')">
    <template #header>
      <h3 class="text-sm font-semibold text-[var(--c-text-1)]">Change wallpaper</h3>
    </template>

    <div class="p-6 space-y-5">
      <div>
        <p class="eyebrow mb-2">Color</p>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="c in SWATCHES" :key="c"
            :style="{ backgroundColor: c }"
            class="w-8 h-8 rounded-lg border border-[var(--c-border-strong)]"
            @click="pickColor(c)"
          />
          <input
            v-model="customColor"
            type="color"
            class="w-8 h-8 rounded-lg border border-[var(--c-border-strong)] cursor-pointer"
            @change="pickColor(customColor)"
          />
        </div>
      </div>

      <div>
        <p class="eyebrow mb-2">Image</p>
        <button
          class="w-full px-3 py-2 bg-[var(--c-surface-deep)] border border-[var(--c-border-strong)] text-[var(--c-text-2)] text-sm rounded-lg hover:bg-[var(--c-hover)] transition-colors"
          @click="fileInput?.click()"
        >
          Upload image...
        </button>
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="onFileChange" />
      </div>

      <p v-if="error" class="status-text text-[var(--c-accent)] text-xs">[ERR] {{ error }}</p>
    </div>

    <template #footer>
      <button
        class="px-3 py-1.5 text-sm text-[var(--c-text-2)] hover:bg-[var(--c-hover)] rounded-lg transition-colors"
        @click="reset"
      >
        Reset to default
      </button>
    </template>
  </Modal>
</template>
