<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { previewUrl } from '../../../lib/file-url'

const props = defineProps<{ path: string; kind: 'image' | 'video' | 'audio' }>()

const url = ref<string | null>(null)
const failed = ref(false)

onMounted(async () => {
  try {
    url.value = await previewUrl(props.path)
  } catch {
    failed.value = true
  }
})
</script>

<template>
  <div class="h-full flex items-center justify-center bg-[var(--c-surface-deep)]">
    <div v-if="failed" class="text-center text-[var(--c-text-3)] text-sm space-y-1">
      <p>Couldn't load this file.</p>
      <p class="status-text">[ERR] {{ path.split('/').pop() }}</p>
    </div>

    <img v-else-if="kind === 'image'" :src="url ?? undefined" :alt="path" class="max-w-full max-h-full object-contain" @error="failed = true" />

    <video v-else-if="kind === 'video'" :src="url ?? undefined" controls autoplay class="max-w-full max-h-full" @error="failed = true" />

    <audio v-else :src="url ?? undefined" controls class="w-full max-w-md" @error="failed = true" />
  </div>
</template>
