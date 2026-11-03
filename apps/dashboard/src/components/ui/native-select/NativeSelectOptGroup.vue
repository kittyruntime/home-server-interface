<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{ class?: HTMLAttributes["class"] }>()
</script>

<template>
  <optgroup data-slot="native-select-optgroup" :class="cn('bg-base-100 text-base-content', props.class)">
    <slot />
  </optgroup>
</template>
