<script setup lang="ts">
import type { ImgHTMLAttributes } from "vue"
import { inject, onBeforeUnmount, watch } from "vue"
import { avatarKey } from "./context"

const props = defineProps<{
  src?: string
  alt?: string
  referrerPolicy?: ImgHTMLAttributes["referrerpolicy"]
  crossOrigin?: "anonymous" | "use-credentials" | ""
}>()

const avatar = inject(avatarKey, null)

// Preload off-DOM: the <img> only renders once the file is known to load,
// so a broken image never shows next to the fallback.
let probe: HTMLImageElement | null = null

function release() {
  if (!probe)
    return
  probe.onload = null
  probe.onerror = null
  probe = null
}

watch(() => props.src, (src) => {
  release()
  if (!avatar)
    return
  if (!src) {
    avatar.status.value = "error"
    return
  }
  avatar.status.value = "loading"
  const img = new Image()
  probe = img
  img.onload = () => {
    avatar.status.value = "loaded"
  }
  img.onerror = () => {
    avatar.status.value = "error"
  }
  if (props.referrerPolicy)
    img.referrerPolicy = props.referrerPolicy
  if (props.crossOrigin !== undefined)
    img.crossOrigin = props.crossOrigin
  img.src = src
}, { immediate: true })

onBeforeUnmount(release)
</script>

<template>
  <img
    v-if="!avatar || avatar.status.value === 'loaded'"
    data-slot="avatar-image"
    :src="src"
    :alt="alt"
    :referrerpolicy="referrerPolicy"
    :crossorigin="crossOrigin"
    class="aspect-square size-full"
  >
</template>
