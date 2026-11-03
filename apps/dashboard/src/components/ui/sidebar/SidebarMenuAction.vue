<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  showOnHover?: boolean
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <button
    type="button"
    data-slot="sidebar-menu-action"
    :class="cn(
      'btn btn-ghost btn-xs btn-square absolute top-1/2 right-1 -translate-y-1/2 [&>svg]:size-4 [&>svg]:shrink-0',
      showOnHover && '[@media(hover:hover)]:opacity-0 group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100 focus-visible:opacity-100',
      props.class,
    )"
  >
    <slot />
  </button>
</template>
