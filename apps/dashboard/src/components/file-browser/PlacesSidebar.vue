<script setup lang="ts">
type Place = { id: string; name: string; path: string }

defineProps<{
  places: Place[]
  activePlaceId: string | null
}>()

defineEmits<{ select: [place: Place] }>()
</script>

<template>
  <aside class="w-44 flex-shrink-0 border-r border-[var(--c-border)] bg-[var(--c-sidebar)] flex flex-col">
    <div class="px-3 pt-3.5 pb-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)] select-none">
      Places
    </div>
    <nav class="flex flex-col gap-0.5 px-2 pb-3 overflow-y-auto flex-1">
      <button
        v-for="place in places"
        :key="place.id"
        @click.stop="$emit('select', place)"
        :class="[
          'flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left text-sm transition-colors',
          activePlaceId === place.id
            ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
            : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]',
        ]"
      >
        <svg v-if="place.id === '__root__'" class="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-13.5 0v-1.5m13.5 1.5v-1.5m0-10.5a3 3 0 00-3-3H9.75a3 3 0 00-3 3m9.75 0a3 3 0 01-3 3h-3a3 3 0 01-3-3m9.75 0H4.5m15 0h.008v.008H19.5v-.008z"/>
        </svg>
        <svg v-else class="w-3.5 h-3.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
        </svg>
        <span class="truncate">{{ place.name }}</span>
      </button>
      <p v-if="places.length === 0" class="text-xs text-[var(--c-text-3)] italic px-2.5 py-2">No places configured.</p>
    </nav>
  </aside>
</template>
