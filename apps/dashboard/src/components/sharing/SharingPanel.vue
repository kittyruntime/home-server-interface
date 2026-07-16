<script setup lang="ts">
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
    <div class="sm:hidden flex-shrink-0 border-b border-[var(--c-border)] bg-[var(--c-sidebar)] px-4 py-2.5">
      <select v-model="active" class="w-full bg-transparent text-sm text-[var(--c-text-2)] focus:outline-none">
        <option v-for="item in nav" :key="item.id" :value="item.id">{{ item.label }}</option>
      </select>
    </div>

    <!-- Left nav -->
    <nav class="hidden sm:flex w-48 flex-shrink-0 border-r border-[var(--c-border)] bg-[var(--c-sidebar)] py-5 px-2 flex-col gap-0.5 overflow-y-auto">
      <div v-for="item in nav" :key="item.id" class="relative flex items-center">
        <span
          v-if="active === item.id"
          class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-[var(--c-accent)] rounded-r-full"
        />
        <button
          @click="active = item.id"
          :class="[
            'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left',
            active === item.id
              ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
              : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]',
          ]"
        >
          <!-- Shares -->
          <svg v-if="item.id === 'shares'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h3.586a1 1 0 01.707.293L11 7h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
          </svg>
          <!-- Connections -->
          <svg v-else-if="item.id === 'connections'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z"/>
          </svg>
          <!-- Diagnostics -->
          <svg v-else-if="item.id === 'diagnostics'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4M12 3a9 9 0 100 18 9 9 0 000-18z"/>
          </svg>
          {{ item.label }}
        </button>
      </div>
    </nav>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto">
      <div class="p-8 max-w-4xl">
        <SharesSection      v-if="active === 'shares'" />
        <ConnectionsSection v-else-if="active === 'connections'" />
        <DiagnosticsSection v-else-if="active === 'diagnostics'" />
      </div>
    </div>

  </div>
</template>
