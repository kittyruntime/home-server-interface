<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import MenuContent from "./MenuContent.vue"

const props = defineProps<{ class?: HTMLAttributes["class"] }>()
</script>

<template>
  <MenuContent side="right" align="start" :side-offset="0" :align-offset="-4" class="ms-0 ps-1 before:hidden" :class="props.class">
    <slot />
  </MenuContent>
</template>
