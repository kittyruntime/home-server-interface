<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { ref } from 'vue'
import Modal from '../ui/Modal.vue'
import { useWallpaper } from '../../lib/wallpaper'

const { t } = useI18n()

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
    error.value = e?.message ?? t('uis.desktop.WallpaperPicker.failedToSetColor')
  }
}

async function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  error.value = null
  try {
    await setImage(file)
  } catch (e: any) {
    error.value = e?.message ?? t('uis.desktop.WallpaperPicker.failedToUploadImage')
  } finally {
    ;(e.target as HTMLInputElement).value = ''
  }
}

async function reset() {
  error.value = null
  try {
    await clear()
  } catch (e: any) {
    error.value = e?.message ?? t('uis.desktop.WallpaperPicker.failedToResetWallpaper')
  }
}
</script>

<template>
  <Modal panel-class="w-full max-w-sm" @close="emit('close')">
    <template #header>
      <h3 class="text-sm font-semibold text-foreground">{{ t('ui.desktop.WallpaperPicker.changeWallpaper') }}</h3>
    </template>

    <div class="p-6 space-y-5">
      <div>
        <p class="eyebrow mb-2">{{ t('ui.desktop.WallpaperPicker.color') }}</p>
        <div class="flex flex-wrap gap-2">
          <Button
            v-for="c in SWATCHES" :key="c"
            variant="outline"
            size="icon"
            :aria-label="`Color ${c}`"
            :style="{ backgroundColor: c }"
            class="size-8 rounded-lg hover:opacity-80"
            @click="pickColor(c)"
          />
          <input
            v-model="customColor"
            type="color"
            class="w-8 h-8 rounded-lg border border-input cursor-pointer"
            @change="pickColor(customColor)"
          />
        </div>
      </div>

      <div>
        <p class="eyebrow mb-2">{{ t('ui.desktop.WallpaperPicker.image') }}</p>
        <Button variant="outline" size="sm"
          class="w-full bg-muted text-foreground/80"
          @click="fileInput?.click()"
        >
          {{ t('ui.desktop.WallpaperPicker.uploadImage') }}
        </Button>
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden" @change="onFileChange" />
      </div>

      <p v-if="error" class="status-text text-primary text-xs">[ERR] {{ error }}</p>
    </div>

    <template #footer>
      <Button variant="ghost" size="sm"
        class="text-foreground/80"
        @click="reset"
      >
        {{ t('ui.desktop.WallpaperPicker.resetToDefault') }}
      </Button>
    </template>
  </Modal>
</template>
