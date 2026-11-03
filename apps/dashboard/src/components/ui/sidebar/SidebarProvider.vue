<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="sidebar-wrapper"
    :style="{ '--sidebar-width': '16rem' }"
    :class="cn('flex min-h-svh w-full', props.class)"
  >
    <slot />
  </div>
</template>
