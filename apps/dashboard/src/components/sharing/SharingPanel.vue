<script setup lang="ts">
import { CircleCheckIcon, FolderIcon, WifiIcon } from '@lucide/vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ref } from 'vue'
import SharesSection from './SharesSection.vue'
import ConnectionsSection from './ConnectionsSection.vue'
import DiagnosticsSection from './DiagnosticsSection.vue'

type SectionId = 'shares' | 'connections' | 'diagnostics'

interface NavItem { id: SectionId; label: string }

const nav: NavItem[] = [
  { id: 'shares',      label: 'Shares' },
  { id: 'connections', label: 'Connections' },
  { id: 'diagnostics', label: 'Diagnostics' },
]

const active = ref<SectionId>('shares')
</script>

<template>
  <div class="flex flex-col sm:flex-row h-full">

    <!-- Mobile picker -->
    <div class="sm:hidden flex-shrink-0 border-b border-border bg-sidebar px-4 py-2.5">
      <Select v-model="active">
        <SelectTrigger class="w-full" aria-label="Section">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="item in nav" :key="item.id" :value="item.id">{{ item.label }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <!-- Left nav -->
    <nav class="hidden sm:flex w-48 flex-shrink-0 border-r border-border bg-sidebar py-5 px-2 flex-col gap-0.5 overflow-y-auto">
      <div v-for="item in nav" :key="item.id" class="relative flex items-center">
        <span
          v-if="active === item.id"
          class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-full"
        />
        <button
          @click="active = item.id"
          :class="[
            'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left',
            active === item.id
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          ]"
        >
          <!-- Shares -->
          <FolderIcon v-if="item.id === 'shares'" class="w-4 h-4 shrink-0" aria-hidden="true" />
          <!-- Connections -->
          <WifiIcon v-else-if="item.id === 'connections'" class="w-4 h-4 shrink-0" aria-hidden="true" />
          <!-- Diagnostics -->
          <CircleCheckIcon v-else-if="item.id === 'diagnostics'" class="w-4 h-4 shrink-0" aria-hidden="true" />
          {{ item.label }}
        </button>
      </div>
    </nav>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto">
      <div class="p-4 sm:p-8 max-w-4xl">
        <SharesSection      v-if="active === 'shares'" />
        <ConnectionsSection v-else-if="active === 'connections'" />
        <DiagnosticsSection v-else-if="active === 'diagnostics'" />
      </div>
    </div>

  </div>
</template>
