<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import MenuContent from "../menu/MenuContent.vue"

const props = withDefaults(defineProps<{
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
  sideOffset?: number
  alignOffset?: number
  class?: HTMLAttributes["class"]
}>(), {
  side: "bottom",
  align: "center",
  sideOffset: 4,
  alignOffset: 0,
})
</script>

<template>
  <MenuContent v-bind="props">
    <slot />
  </MenuContent>
</template>
