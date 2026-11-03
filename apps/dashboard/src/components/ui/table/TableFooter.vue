<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <tfoot
    data-slot="table-footer"
    :class="cn('bg-base-200/50 font-medium', props.class)"
  >
    <slot />
  </tfoot>
</template>
