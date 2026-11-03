<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="sidebar-group-label"
    :class="cn('text-base-content/70 flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium', props.class)"
  >
    <slot />
  </div>
</template>
