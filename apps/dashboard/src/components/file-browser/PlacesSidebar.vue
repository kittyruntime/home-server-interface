<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { FolderIcon, InfoIcon, ServerIcon } from '@lucide/vue'
type Place = { id: string; name: string; path: string }

defineProps<{
  places: Place[]
  activePlaceId: string | null
}>()

defineEmits<{ select: [place: Place]; openProperties: [place: Place] }>()
</script>

<template>
  <aside class="w-44 flex-shrink-0 border-r border-border bg-sidebar flex flex-col">
    <div class="px-3 pt-3.5 pb-2 text-2xs font-semibold uppercase tracking-caps text-muted-foreground select-none">
      Places
    </div>
    <nav class="flex flex-col gap-0.5 px-2 pb-3 overflow-y-auto flex-1">
      <Button
        v-for="place in places"
        :key="place.id"
        variant="ghost"
        @click.stop="$emit('select', place)"
        :class="[
          'group h-auto w-full justify-start gap-2.5 px-2.5 py-2 rounded-lg text-left font-normal',
          activePlaceId === place.id
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        ]"
      >
        <ServerIcon v-if="place.id === '__root__'" class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <FolderIcon v-else class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span class="truncate flex-1">{{ place.name }}</span>
        <span
          class="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 p-0.5 rounded-sm hover:bg-black/10"
          @click.stop="$emit('openProperties', place)"
          title="Properties"
        >
          <InfoIcon class="w-3.5 h-3.5" aria-hidden="true" />
        </span>
      </Button>
      <p v-if="places.length === 0" class="text-xs text-muted-foreground px-2.5 py-2 leading-snug">
        No places yet. Ask an admin to grant you access to a folder.
      </p>
    </nav>
  </aside>
</template>
