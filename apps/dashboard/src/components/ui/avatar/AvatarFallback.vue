<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue"
import { cn } from "@/lib/utils"
import { avatarKey } from "./context"

const props = defineProps<{
  /** Wait this long (ms) before showing, so a fast image does not flash the fallback. */
  delayMs?: number
  class?: HTMLAttributes["class"]
}>()

const avatar = inject(avatarKey, null)
const delayed = ref(props.delayMs === undefined)
let timer: ReturnType<typeof setTimeout> | undefined

onMounted(() => {
  if (props.delayMs !== undefined)
    timer = setTimeout(() => { delayed.value = true }, props.delayMs)
})
onBeforeUnmount(() => clearTimeout(timer))

const visible = computed(() => delayed.value && avatar?.status.value !== "loaded")
</script>

<template>
  <span
    v-if="visible"
    data-slot="avatar-fallback"
    :class="cn('bg-base-200 text-base-content flex size-full items-center justify-center rounded-full', props.class)"
  >
    <slot />
  </span>
</template>
