<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <ul
    data-slot="sidebar-menu"
    :class="cn('menu w-full min-w-0 gap-1 p-0', props.class)"
  >
    <slot />
  </ul>
</template>
