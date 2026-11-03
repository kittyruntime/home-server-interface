<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <caption
    data-slot="table-caption"
    :class="cn('text-base-content/60 mt-4 text-sm', props.class)"
  >
    <slot />
  </caption>
</template>
