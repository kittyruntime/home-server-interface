<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ButtonVariants } from "@/components/ui/button"
import { computed, inject } from "vue"
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import { paginationKey } from "./context"

const props = withDefaults(defineProps<{
  value: number
  size?: ButtonVariants["size"]
  class?: HTMLAttributes["class"]
  isActive?: boolean
}>(), {
  size: "icon",
})

const pagination = inject(paginationKey)
const disabled = computed(() => pagination?.disabled.value ?? false)
</script>

<template>
  <button
    type="button"
    data-slot="pagination-item"
    :aria-label="`Page ${value}`"
    :aria-current="isActive ? 'page' : undefined"
    :data-selected="isActive ? true : undefined"
    :disabled="disabled"
    :class="cn(buttonVariants({ variant: 'secondary', size }), 'join-item', isActive && 'btn-primary', props.class)"
    @click="pagination?.setPage(value)"
  >
    <slot />
  </button>
</template>
