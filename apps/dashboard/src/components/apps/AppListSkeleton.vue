<script setup lang="ts">
import { Skeleton } from '@/components/ui/skeleton'
import { LOADING } from '../../lib/loading'

// The installed apps while their list loads: the page's header, then the
// rows of the list card, so nothing moves when the real ones arrive.
const widths = [34, 46, 28, 40, 36]
</script>

<template>
  <div class="skeleton-in" role="status" :aria-label="LOADING.default">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <Skeleton class="h-7 w-40" />
        <Skeleton class="mt-2.5 h-4 w-52" />
      </div>
      <Skeleton class="h-9 w-full sm:w-72" />
    </div>
    <ul class="mt-7 divide-y divide-base-300 overflow-hidden rounded-box border border-base-300 bg-base-100">
      <li v-for="(w, i) in widths" :key="i" class="flex items-center gap-3.5 px-4 py-3">
        <Skeleton class="size-11 shrink-0 rounded-[23%]" />
        <div class="min-w-0 flex-1 space-y-2">
          <Skeleton class="h-3.5" :style="{ width: `${w}%` }" />
          <Skeleton class="h-3" :style="{ width: `${w + 22}%` }" />
        </div>
        <Skeleton class="hidden h-3 w-16 sm:block" />
        <Skeleton class="h-8 w-20 shrink-0" />
      </li>
    </ul>
  </div>
</template>
