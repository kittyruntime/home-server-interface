<script setup lang="ts">
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'

defineProps<{
  page:      number
  pageCount: number
  total:     number
  pageSize:  number
}>()
const emit = defineEmits<{ 'update:page': [n: number] }>()
</script>

<template>
  <div v-if="pageCount > 1" class="flex items-center justify-between gap-2 px-1">
    <span class="text-xs text-muted-foreground">
      {{ (page - 1) * pageSize + 1 }}–{{ Math.min(page * pageSize, total) }} of {{ total }}
    </span>
    <Pagination
      v-slot="{ page: current }"
      :page="page"
      :total="total"
      :items-per-page="pageSize"
      :sibling-count="1"
      class="mx-0 w-auto"
      @update:page="emit('update:page', $event)"
    >
      <PaginationContent v-slot="{ items }">
        <PaginationPrevious size="icon-sm" aria-label="Previous page"><span class="sr-only">Previous page</span></PaginationPrevious>
        <template v-for="(item, index) in items" :key="index">
          <PaginationItem v-if="item.type === 'page'" :value="item.value" :is-active="item.value === current" size="icon-sm">
            {{ item.value }}
          </PaginationItem>
          <PaginationEllipsis v-else :index="index" />
        </template>
        <PaginationNext size="icon-sm" aria-label="Next page"><span class="sr-only">Next page</span></PaginationNext>
      </PaginationContent>
    </Pagination>
  </div>
</template>
