<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="sidebar"
    :class="cn('bg-base-100 text-base-content flex w-(--sidebar-width) flex-col', props.class)"
  >
    <slot />
  </div>
</template>
