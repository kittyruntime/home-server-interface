<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div
    data-slot="card"
    :class="
      cn(
        'card card-border bg-base-100 text-base-content gap-6 py-6 shadow-sm',
        props.class,
      )
    "
  >
    <slot />
  </div>
</template>
