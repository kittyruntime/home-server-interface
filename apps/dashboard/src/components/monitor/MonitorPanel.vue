<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { ActivityIcon, ClipboardListIcon, HistoryIcon, ListTreeIcon, TriangleAlertIcon } from '@lucide/vue'
import SectionNav from '@/components/ui/SectionNav.vue'
import PerformanceSection from './PerformanceSection.vue'
import ProcessesSection from './ProcessesSection.vue'
import HistorySection from './HistorySection.vue'
import AlertsSection from './AlertsSection.vue'
import AuditLogSection from '../AuditLogSection.vue'

const { t } = useI18n()

type SectionId = 'performance' | 'processes' | 'history' | 'alerts' | 'audit'
const icons: Record<SectionId, Component> = {
  performance: ActivityIcon, processes: ListTreeIcon, history: HistoryIcon, alerts: TriangleAlertIcon, audit: ClipboardListIcon,
}
const active = ref<SectionId>('performance')
/** The owner to open when the overview sends to the Processes section. */
const focus = ref<string | null>(null)
function openProcesses(key: string | null) {
  focus.value = key
  active.value = 'processes'
}
const navItems = computed(() => (Object.keys(icons) as SectionId[]).map(id => ({ id, label: t(`monitor.nav.${id}`), icon: icons[id] })))
</script>

<template>
  <!-- The layout follows this panel's width (a desktop window or the classic
       view), not the screen's. -->
  <div class="@container h-full">
    <div class="flex h-full flex-col @2xl:flex-row">
      <SectionNav v-model="active" @update:model-value="focus = null" :items="navItems" container />
      <div v-if="active === 'processes'" class="flex min-h-0 flex-1 flex-col p-4 @2xl:p-6">
        <ProcessesSection :focus="focus" />
      </div>
      <div v-else class="flex-1 overflow-y-auto">
        <div class="p-4 @2xl:p-6" :class="active === 'performance' ? 'max-w-6xl' : 'max-w-5xl'">
          <PerformanceSection v-if="active === 'performance'" @open-processes="openProcesses" />
          <HistorySection v-else-if="active === 'history'" />
          <AlertsSection v-else-if="active === 'alerts'" />
          <AuditLogSection v-else-if="active === 'audit'" />
        </div>
      </div>
    </div>
  </div>
</template>
