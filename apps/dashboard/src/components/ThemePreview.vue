<script setup lang="ts">
// A miniature of the interface drawn in one theme: sidebar, text lines, a
// panel and the theme's main button, so themes compare by what they look like.
defineProps<{ theme: string }>()
</script>

<template>
  <span :data-theme="theme" class="flex h-16 gap-1.5 bg-base-100 p-2">
    <span class="flex w-2.5 shrink-0 flex-col gap-1 rounded-[0.1875rem] bg-base-200 p-0.5">
      <span class="h-1.5 rounded-[0.125rem] bg-primary" />
      <span class="h-1.5 rounded-[0.125rem] bg-base-content/20" />
      <span class="h-1.5 rounded-[0.125rem] bg-base-content/20" />
    </span>
    <span class="flex min-w-0 flex-1 flex-col gap-1">
      <span class="h-1.5 w-3/5 rounded-full bg-base-content/80" />
      <span class="h-1 w-4/5 rounded-full bg-base-content/30" />
      <span class="mt-auto flex items-end justify-between gap-1 rounded-[0.1875rem] border border-base-300 bg-base-200 p-1">
        <span class="flex gap-0.5">
          <span class="size-1.5 rounded-full bg-secondary" />
          <span class="size-1.5 rounded-full bg-accent" />
        </span>
        <span class="h-2 w-5 rounded-[0.125rem] bg-primary" />
      </span>
    </span>
  </span>
</template>
