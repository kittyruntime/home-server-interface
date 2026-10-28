<script setup lang="ts">
import { ActivityIcon, ClipboardListIcon, LayoutGridIcon, MonitorIcon, TriangleAlertIcon } from '@lucide/vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ref } from 'vue'
import OverviewSection from '../OverviewSection.vue'
import SystemInfoSection from '../SystemInfoSection.vue'
import MonitoringSection from '../MonitoringSection.vue'
import AlertsSection from './AlertsSection.vue'
import AuditLogSection from '../AuditLogSection.vue'

type SectionId = 'overview' | 'system-info' | 'monitoring' | 'alerts' | 'audit'

interface NavItem { id: SectionId; label: string }

const nav: NavItem[] = [
  { id: 'overview',    label: 'Summary' },
  { id: 'system-info', label: 'System info' },
  { id: 'monitoring',  label: 'Monitoring' },
  { id: 'alerts',      label: 'Alerts' },
  { id: 'audit',       label: 'Audit log' },
]

const active = ref<SectionId>('overview')
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
          <!-- Overview -->
          <LayoutGridIcon v-if="item.id === 'overview'" class="w-4 h-4 shrink-0" aria-hidden="true" />
          <!-- System info -->
          <MonitorIcon v-else-if="item.id === 'system-info'" class="w-4 h-4 shrink-0" aria-hidden="true" />
          <!-- Monitoring -->
          <ActivityIcon v-else-if="item.id === 'monitoring'" class="w-4 h-4 shrink-0" aria-hidden="true" />
          <!-- Alerts -->
          <TriangleAlertIcon v-else-if="item.id === 'alerts'" class="w-4 h-4 shrink-0" aria-hidden="true" />
          <!-- Audit -->
          <ClipboardListIcon v-else-if="item.id === 'audit'" class="w-4 h-4 shrink-0" aria-hidden="true" />
          {{ item.label }}
        </button>
      </div>
    </nav>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto">
      <div :class="['p-4 sm:p-8', active === 'audit' ? 'max-w-5xl' : 'max-w-4xl']">
        <OverviewSection    v-if="active === 'overview'" />
        <SystemInfoSection  v-else-if="active === 'system-info'" />
        <MonitoringSection  v-else-if="active === 'monitoring'" />
        <AlertsSection      v-else-if="active === 'alerts'" />
        <AuditLogSection    v-else-if="active === 'audit'" />
      </div>
    </div>

  </div>
</template>
