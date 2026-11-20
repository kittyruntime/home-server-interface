<script setup lang="ts">
import { LockIcon } from '@lucide/vue'
import RankBar from './RankBar.vue'
import { RANK_GRID } from './owners'

// One process under its owner, selectable to read its command or end it.
defineProps<{
  id: string; name: string; sub: string; title: string
  level: number; value: string; color: string; others: string[]
  selected: boolean; locked?: string; flag?: string
}>()
defineEmits<{ select: [] }>()
</script>

<template>
  <button :id="id" type="button" :aria-pressed="selected" :title="title"
    :class="[RANK_GRID, 'w-full rounded-field py-1.5 pr-3 pl-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-base-content/30 @xl:pl-21',
             selected ? 'bg-primary/15 ring-1 ring-inset ring-primary/40' : 'hover:bg-base-200/70']"
    @click="$emit('select')">
    <span class="min-w-0">
      <span class="flex min-w-0 items-center gap-1.5">
        <span class="truncate text-sm text-base-content">{{ name }}</span>
        <LockIcon v-if="locked" class="size-3 shrink-0 text-base-content/60" :aria-label="locked" />
        <span v-if="flag" class="shrink-0 text-2xs text-warning">{{ flag }}</span>
      </span>
      <span class="block truncate text-2xs tabular-nums text-base-content/70">{{ sub }}</span>
    </span>
    <RankBar thin :level="level" :value="value" :color="color" />
    <span v-for="(o, i) in others" :key="i" class="hidden text-right text-xs tabular-nums text-base-content/80 @xl:block">{{ o }}</span>
  </button>
</template>
