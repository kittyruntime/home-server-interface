<script setup lang="ts">
import { ref } from 'vue'
import { useAuth } from '../../../lib/auth'
import { previewUrl } from '../../../lib/file-url'

const props = defineProps<{ path: string; kind: 'image' | 'video' | 'audio' }>()

const { token } = useAuth()
const url = previewUrl(props.path, token.value ?? '')
const failed = ref(false)
</script>

<template>
  <div class="h-full flex items-center justify-center bg-[var(--c-surface-deep)]">
    <div v-if="failed" class="text-center text-[var(--c-text-3)] text-sm space-y-1">
      <p>Couldn't load this file.</p>
      <p class="status-text">[ERR] {{ path.split('/').pop() }}</p>
    </div>

    <img v-else-if="kind === 'image'" :src="url" :alt="path" class="max-w-full max-h-full object-contain" @error="failed = true" />

    <video v-else-if="kind === 'video'" :src="url" controls autoplay class="max-w-full max-h-full" @error="failed = true" />

    <audio v-else :src="url" controls class="w-full max-w-md" @error="failed = true" />
  </div>
</template>
