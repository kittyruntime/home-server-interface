<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ButtonVariants } from "@/components/ui/button"
import { MoreHorizontal } from "@lucide/vue"
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"

const props = withDefaults(defineProps<{
  /** Position in the list, kept for callers that key on it. */
  index?: number
  size?: ButtonVariants["size"]
  class?: HTMLAttributes["class"]
}>(), {
  index: undefined,
  size: "icon",
})
</script>

<template>
  <span
    data-slot="pagination-ellipsis"
    :class="cn(buttonVariants({ variant: 'secondary', size }), 'join-item btn-disabled', props.class)"
  >
    <slot>
      <MoreHorizontal class="size-4" />
      <span class="sr-only">More pages</span>
    </slot>
  </span>
</template>
