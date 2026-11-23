<script setup lang="ts">
import Skeleton from './Skeleton.vue'
import { LOADING } from '../../../lib/loading'

// What an app shows while its code arrives: a page title and a few rows, in
// the layout most panels share, so the page settles instead of popping in.
</script>

<template>
  <div class="skeleton-in h-full overflow-hidden" role="status" :aria-label="LOADING.default">
    <div class="mx-auto w-full max-w-4xl px-4 py-5 sm:px-8 sm:py-8">
      <Skeleton class="h-7 w-48" />
      <Skeleton class="mt-2.5 h-4 w-72 max-w-full" />
      <div class="mt-8 space-y-3">
        <div v-for="i in 5" :key="i" class="flex items-center gap-3.5">
          <Skeleton class="size-11 shrink-0 rounded-[23%]" />
          <div class="min-w-0 flex-1 space-y-2">
            <Skeleton class="h-3.5" :style="{ width: `${[38, 52, 30, 46, 41][i - 1]}%` }" />
            <Skeleton class="h-3 w-3/5" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
