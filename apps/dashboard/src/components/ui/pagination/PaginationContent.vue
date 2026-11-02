<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { inject } from "vue"
import { cn } from "@/lib/utils"
import { paginationKey } from "./context"

const props = defineProps<{ class?: HTMLAttributes["class"] }>()

const pagination = inject(paginationKey)
</script>

<template>
  <div
    data-slot="pagination-content"
    :class="cn('join', props.class)"
  >
    <slot :items="pagination?.items.value ?? []" />
  </div>
</template>
