<script setup lang="ts">
import SectionNav from '@/components/ui/SectionNav.vue'
import { CircleCheckIcon, FolderIcon, WifiIcon } from '@lucide/vue'
import { ref } from 'vue'
import type { Component } from 'vue'
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

const navItems = nav.map(n => ({ ...n, icon: ({ shares: FolderIcon, connections: WifiIcon, diagnostics: CircleCheckIcon } as Record<SectionId, Component>)[n.id] }))
</script>

<template>
  <div class="flex flex-col sm:flex-row h-full">

    <SectionNav v-model="active" :items="navItems" />

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
