<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import { ChevronLeftIcon, ChevronRightIcon } from '@lucide/vue'

const { t } = useI18n()

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
    <span class="text-xs text-base-content/60">
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
        <PaginationPrevious size="icon-sm" :aria-label="t('ui.shared.Pagination.previousPage')"><ChevronLeftIcon aria-hidden="true" /><span class="sr-only">{{ t('ui.shared.Pagination.previousPage') }}</span></PaginationPrevious>
        <template v-for="(item, index) in items" :key="index">
          <PaginationItem v-if="item.type === 'page'" :value="item.value" :is-active="item.value === current" size="icon-sm">
            {{ item.value }}
          </PaginationItem>
          <PaginationEllipsis v-else :index="index" size="icon-sm" />
        </template>
        <PaginationNext size="icon-sm" :aria-label="t('ui.shared.Pagination.nextPage')"><span class="sr-only">{{ t('ui.shared.Pagination.nextPage') }}</span><ChevronRightIcon aria-hidden="true" /></PaginationNext>
      </PaginationContent>
    </Pagination>
  </div>
</template>
