<script lang="ts" setup>
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <ol
    data-slot="breadcrumb-list"
    :class="cn('text-base-content/60 flex-wrap gap-1.5 text-sm break-words whitespace-normal sm:gap-2.5', props.class)"
  >
    <slot />
  </ol>
</template>
