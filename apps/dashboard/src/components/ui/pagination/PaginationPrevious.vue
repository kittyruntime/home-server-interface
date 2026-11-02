<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ButtonVariants } from "@/components/ui/button"
import { ChevronLeftIcon } from "@lucide/vue"
import { computed, inject } from "vue"
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import { paginationKey } from "./context"

const props = withDefaults(defineProps<{
  size?: ButtonVariants["size"]
  class?: HTMLAttributes["class"]
}>(), {
  size: "default",
})

const pagination = inject(paginationKey)
const disabled = computed(() => !pagination || pagination.disabled.value || pagination?.page.value === 1)
</script>

<template>
  <button
    type="button"
    data-slot="pagination-previous"
    :disabled="disabled"
    :class="cn(buttonVariants({ variant: 'secondary', size }), 'join-item gap-1 px-2.5 sm:pr-2.5', props.class)"
    @click="pagination?.setPage((pagination?.page.value ?? 1) - 1)"
  >
    <slot>
      <ChevronLeftIcon />
      <span class="hidden sm:block">Previous</span>
    </slot>
  </button>
</template>
