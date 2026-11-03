<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <th
    data-slot="table-head"
    :class="cn('text-base-content h-10 px-2 py-0 text-left align-middle font-medium whitespace-nowrap [&:has([type=checkbox])]:pr-0', props.class)"
  >
    <slot />
  </th>
</template>
