<script setup lang="ts">
import type { Component } from 'vue'
import { ChevronRightIcon } from '@lucide/vue'
import RankBar from './RankBar.vue'
import AppTile from '../../store/AppTile.vue'
import { RANK_GRID } from './owners'

// One owner in the ranking: what it is, the share it takes, the two other
// measures. Expandable when `expanded` is given.
// `expanded` keeps undefined when left out (not false), so a row that opens
// elsewhere carries no chevron and no aria-expanded.
withDefaults(defineProps<{
  icon: Component; name: string; sub: string
  level: number; value: string; color: string; others: string[]
  expanded?: boolean; lit?: boolean
  tile?: { svg?: string | null; glyph?: string | null; name: string } | null
}>(), { expanded: undefined, lit: false, tile: null })
defineEmits<{ activate: [] }>()
</script>

<template>
  <button type="button" :aria-expanded="expanded"
    :class="[RANK_GRID, 'w-full rounded-field px-3 py-2.5 text-left outline-none transition-colors duration-(--dur-slow) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-base-content/30',
             lit ? 'bg-primary/10' : 'hover:bg-base-200/70']"
    @click="$emit('activate')">
    <span class="flex min-w-0 items-center gap-2 @md:gap-3">
      <ChevronRightIcon v-if="expanded !== undefined" class="size-4 shrink-0 text-base-content/60 transition-transform duration-(--dur-base)"
        :class="expanded && 'rotate-90'" aria-hidden="true" />
      <AppTile v-if="tile" :svg="tile.svg" :glyph="tile.glyph" :name="tile.name" size="sm" class="hidden! @md:grid!" />
      <span v-else class="hidden size-8 shrink-0 place-items-center rounded-field bg-base-200 text-base-content/80 @md:grid" aria-hidden="true">
        <component :is="icon" class="size-4" />
      </span>
      <span class="min-w-0">
        <span class="block truncate text-sm font-medium text-base-content">{{ name }}</span>
        <span class="block truncate text-xs text-base-content/70">{{ sub }}</span>
      </span>
    </span>
    <RankBar :level="level" :value="value" :color="color" />
    <span v-for="(o, i) in others" :key="i" class="hidden text-right text-sm tabular-nums text-base-content/80 @xl:block">{{ o }}</span>
  </button>
</template>
