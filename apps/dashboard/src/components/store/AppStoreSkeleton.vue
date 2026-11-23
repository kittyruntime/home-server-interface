<script setup lang="ts">
import { Skeleton } from '@/components/ui/skeleton'
import { LOADING } from '../../lib/loading'

// The App Store while the catalog loads: categories, the featured app and
// the rows of apps, in their final places.
const chips = [44, 64, 58, 70, 62, 84, 54]
const rows = [30, 42, 36, 48, 26, 40]
</script>

<template>
  <div class="skeleton-in" role="status" :aria-label="LOADING.default">
    <div class="mt-5 flex gap-2 overflow-hidden">
      <Skeleton v-for="(w, i) in chips" :key="i" class="h-8 shrink-0" :style="{ width: `${w}px` }" />
    </div>
    <div class="mt-6 flex flex-col gap-5 rounded-box bg-base-200 p-6 sm:flex-row sm:items-center sm:gap-7 sm:p-8">
      <Skeleton class="size-[6.5rem] shrink-0 rounded-[23%]" />
      <div class="min-w-0 flex-1 space-y-3">
        <Skeleton class="h-5 w-40" />
        <Skeleton class="h-3.5 w-3/5" />
        <Skeleton class="h-3.5 w-4/5" />
        <Skeleton class="mt-1 h-9 w-24" />
      </div>
    </div>
    <Skeleton class="mt-8 h-5 w-32" />
    <ul class="mt-2 grid grid-cols-1 gap-x-10 lg:grid-cols-2">
      <li v-for="(w, i) in rows" :key="i" class="flex items-center gap-4 py-3.5">
        <Skeleton class="size-11 shrink-0 rounded-[23%]" />
        <div class="min-w-0 flex-1 space-y-2">
          <Skeleton class="h-3.5" :style="{ width: `${w}%` }" />
          <Skeleton class="h-3" :style="{ width: `${w + 30}%` }" />
        </div>
        <Skeleton class="h-8 w-20 shrink-0" />
      </li>
    </ul>
  </div>
</template>
