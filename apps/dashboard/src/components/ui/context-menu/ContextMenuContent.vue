<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import MenuContent from "../menu/MenuContent.vue"

defineProps<{ class?: HTMLAttributes["class"] }>()
</script>

<template>
  <MenuContent :class="$props.class">
    <slot />
  </MenuContent>
</template>
