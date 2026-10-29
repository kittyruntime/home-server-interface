<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import SectionNav from '@/components/ui/SectionNav.vue'
import { ActivityIcon, ClipboardListIcon, LayoutGridIcon, MonitorIcon, TriangleAlertIcon } from '@lucide/vue'
import { ref, computed } from 'vue'
import type { Component } from 'vue'
import OverviewSection from '../OverviewSection.vue'
import SystemInfoSection from '../SystemInfoSection.vue'
import MonitoringSection from '../MonitoringSection.vue'
import AlertsSection from './AlertsSection.vue'
import AuditLogSection from '../AuditLogSection.vue'

const { t } = useI18n()

type SectionId = 'overview' | 'system-info' | 'monitoring' | 'alerts' | 'audit'

interface NavItem { id: SectionId; label: string }

const nav: NavItem[] = [
  { id: 'overview',    label: 'overview' },
  { id: 'system-info', label: 'systemInfo' },
  { id: 'monitoring',  label: 'monitoring' },
  { id: 'alerts',      label: 'alerts' },
  { id: 'audit',       label: 'audit' },
]

const active = ref<SectionId>('overview')

const ICONS: Record<SectionId, Component> = {
  overview: LayoutGridIcon, 'system-info': MonitorIcon, monitoring: ActivityIcon,
  alerts: TriangleAlertIcon, audit: ClipboardListIcon,
}
const navItems = computed(() => nav.map(n => ({ ...n, label: t(`monitor.nav.${n.label}`), icon: ICONS[n.id] })))
</script>

<template>
  <div class="flex flex-col sm:flex-row h-full">

    <SectionNav v-model="active" :items="navItems" />

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
