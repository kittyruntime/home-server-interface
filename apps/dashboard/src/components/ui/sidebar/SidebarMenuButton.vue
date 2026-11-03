<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  isActive?: boolean
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <button
    type="button"
    data-slot="sidebar-menu-button"
    :data-active="isActive"
    :class="cn(
      'gap-2 text-left focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-primary [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
      'group-has-data-[slot=sidebar-menu-action]/menu-item:pr-8',
      isActive && 'menu-active font-medium',
      props.class,
    )"
  >
    <slot />
  </button>
</template>
