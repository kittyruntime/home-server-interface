<script setup lang="ts">
import type { HTMLAttributes } from "vue"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <tbody
    data-slot="table-body"
    :class="props.class"
  >
    <slot />
  </tbody>
</template>
