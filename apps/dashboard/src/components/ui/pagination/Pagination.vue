<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { computed, provide, ref } from "vue"
import { cn } from "@/lib/utils"
import { getRange, paginationKey } from "./context"

const props = withDefaults(defineProps<{
  page?: number
  defaultPage?: number
  total?: number
  itemsPerPage?: number
  siblingCount?: number
  showEdges?: boolean
  disabled?: boolean
  class?: HTMLAttributes["class"]
}>(), {
  page: undefined,
  defaultPage: 1,
  total: 0,
  itemsPerPage: 10,
  siblingCount: 2,
})

const emits = defineEmits<{
  "update:page": [page: number]
}>()

const local = ref(props.defaultPage)
const page = computed(() => props.page ?? local.value)
const pageCount = computed(() => Math.ceil(props.total / props.itemsPerPage))
const items = computed(() => getRange(page.value, pageCount.value, props.siblingCount, props.showEdges)
  .map(value => typeof value === "number" ? { type: "page" as const, value } : { type: "ellipsis" as const }))

provide(paginationKey, {
  page,
  pageCount,
  items,
  disabled: computed(() => props.disabled),
  setPage(next) {
    const clamped = Math.max(1, Math.min(next, pageCount.value))
    if (clamped === page.value)
      return
    local.value = clamped
    emits("update:page", clamped)
  },
})
</script>

<template>
  <nav
    role="navigation"
    aria-label="pagination"
    data-slot="pagination"
    :class="cn('mx-auto flex w-full justify-center', props.class)"
  >
    <slot :page="page" :page-count="pageCount" />
  </nav>
</template>
