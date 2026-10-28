<script setup lang="ts">
const props = defineProps<{
  page:      number
  pageCount: number
  total:     number
  pageSize:  number
}>()
const emit = defineEmits<{ 'update:page': [n: number] }>()

function goPage(n: number) {
  emit('update:page', Math.max(1, Math.min(n, props.pageCount)))
}
</script>

<template>
  <div v-if="pageCount > 1" class="flex items-center justify-between px-1">
    <span class="text-xs text-muted-foreground">
      {{ (page - 1) * pageSize + 1 }}–{{ Math.min(page * pageSize, total) }} of {{ total }}
    </span>
    <div class="flex items-center gap-1">
      <button
        @click="goPage(page - 1)"
        :disabled="page === 1"
        aria-label="Previous page"
        class="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/>
        </svg>
      </button>
      <template v-for="n in pageCount" :key="n">
        <button
          @click="goPage(n)"
          :class="[
            'w-7 h-7 rounded-lg text-xs font-medium transition-colors',
            n === page
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent',
          ]"
        >{{ n }}</button>
      </template>
      <button
        @click="goPage(page + 1)"
        :disabled="page === pageCount"
        aria-label="Next page"
        class="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
        </svg>
      </button>
    </div>
  </div>
</template>
