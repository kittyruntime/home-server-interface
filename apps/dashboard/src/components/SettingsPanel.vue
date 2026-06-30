<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAuth } from '../lib/auth'
import ProfileSection from './ProfileSection.vue'
import UserListPanel from './UserListPanel.vue'
import PlacesSection from './PlacesSection.vue'
import RolesSection from './RolesSection.vue'
import UpdateSection from './UpdateSection.vue'
import PhysicalDisksSection from './storage/PhysicalDisksSection.vue'
import RaidSection           from './storage/RaidSection.vue'
import LvmSection            from './storage/LvmSection.vue'
import MountsSection         from './storage/MountsSection.vue'
import SystemSection from './SystemSection.vue'
import AuditLogSection from './AuditLogSection.vue'
import PermissionsSection from './PermissionsSection.vue'
import OverviewSection from './OverviewSection.vue'

const { isAdmin, canManageUsers } = useAuth()

type SectionId = 'overview' | 'profile' | 'users' | 'places' | 'permissions' | 'roles' | 'updates' | 'disks' | 'raid' | 'lvm' | 'mounts' | 'system' | 'audit'

const props = defineProps<{ focusSection?: SectionId | null }>()

interface NavItem {
  id: SectionId
  label: string
  show: () => boolean
  group?: 'admin'
}

const nav: NavItem[] = [
  { id: 'profile',     label: 'My Profile',  show: () => true },
  { id: 'users',       label: 'Users',       show: () => canManageUsers.value },
  { id: 'overview',    label: 'Overview',    show: () => isAdmin.value, group: 'admin' },
  { id: 'places',      label: 'Places',      show: () => isAdmin.value, group: 'admin' },
  { id: 'permissions', label: 'Permissions', show: () => isAdmin.value, group: 'admin' },
  { id: 'roles',       label: 'Roles',       show: () => isAdmin.value, group: 'admin' },
  { id: 'system',      label: 'System',      show: () => isAdmin.value, group: 'admin' },
  { id: 'disks',  label: 'Disks',   show: () => isAdmin.value, group: 'admin' },
  { id: 'raid',   label: 'RAID',    show: () => isAdmin.value, group: 'admin' },
  { id: 'lvm',    label: 'LVM',     show: () => isAdmin.value, group: 'admin' },
  { id: 'mounts', label: 'Mounts',  show: () => isAdmin.value, group: 'admin' },
  { id: 'updates',     label: 'Updates',     show: () => isAdmin.value, group: 'admin' },
  { id: 'audit',       label: 'Audit Log',   show: () => isAdmin.value, group: 'admin' },
]

const visibleNav = computed(() => nav.filter(n => n.show()))

function showDivider(item: NavItem, index: number): boolean {
  return item.group === 'admin' && index > 0 && !visibleNav.value[index - 1]?.group
}

const active = ref<SectionId>('profile')

watch(() => props.focusSection, s => { if (s) active.value = s })

function focusOn(section: SectionId) {
  active.value = section
}

defineExpose({ focusOn })
</script>

<template>
  <div class="flex flex-col sm:flex-row h-full">

    <!-- ── Mobile section picker ─────────────────────────────────────── -->
    <div class="sm:hidden flex-shrink-0 border-b border-[var(--c-border)] bg-[var(--c-sidebar)] px-4 py-2.5">
      <select v-model="active" class="w-full bg-transparent text-sm text-[var(--c-text-2)] focus:outline-none">
        <option v-for="item in visibleNav" :key="item.id" :value="item.id">{{ item.label }}</option>
      </select>
    </div>

    <!-- ── Left nav ───────────────────────────────────────────────────── -->
    <nav class="hidden sm:flex w-48 flex-shrink-0 border-r border-[var(--c-border)] bg-[var(--c-sidebar)] py-5 px-2 flex-col gap-0.5 overflow-y-auto">

      <template v-for="(item, i) in visibleNav" :key="item.id">

        <!-- Divider before first admin group -->
        <div v-if="showDivider(item, i)" class="mx-2 my-1.5 border-t border-[var(--c-border)]" />

        <div class="relative flex items-center">
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
            <!-- Profile icon -->
            <svg v-if="item.id === 'profile'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
            </svg>
            <!-- Users icon -->
            <svg v-else-if="item.id === 'users'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a4 4 0 00-5.916-3.5M9 20H4v-2a4 4 0 015.916-3.5M15 7a3 3 0 11-6 0 3 3 0 016 0zM21 10a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
            </svg>
            <!-- Overview icon -->
            <svg v-else-if="item.id === 'overview'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"/>
            </svg>
            <!-- Places icon -->
            <svg v-else-if="item.id === 'places'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h3.586a1 1 0 01.707.293L11 7h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
            </svg>
            <!-- Permissions icon -->
            <svg v-else-if="item.id === 'permissions'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/>
            </svg>
            <!-- Roles icon -->
            <svg v-else-if="item.id === 'roles'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
            </svg>
            <!-- System icon -->
            <svg v-else-if="item.id === 'system'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
            </svg>
            <!-- Disks icon -->
            <svg v-else-if="item.id === 'disks'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-13.5 0v-1.5m13.5 1.5v-1.5m0-10.5a3 3 0 00-3-3H9.75a3 3 0 00-3 3m9.75 0a3 3 0 01-3 3h-3a3 3 0 01-3-3m9.75 0H4.5m15 0h.008v.008H19.5v-.008z"/>
            </svg>
            <!-- RAID icon -->
            <svg v-else-if="item.id === 'raid'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10"/>
            </svg>
            <!-- LVM icon -->
            <svg v-else-if="item.id === 'lvm'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 7h18M3 12h18M3 17h18"/>
            </svg>
            <!-- Mounts icon -->
            <svg v-else-if="item.id === 'mounts'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"/>
            </svg>
            <!-- Updates icon -->
            <svg v-else-if="item.id === 'updates'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
            </svg>
            <!-- Audit icon -->
            <svg v-else-if="item.id === 'audit'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/>
            </svg>
            {{ item.label }}
          </button>
        </div>

      </template>

    </nav>

    <!-- ── Content area ───────────────────────────────────────────────── -->
    <div class="flex-1 overflow-y-auto">
      <div :class="['p-8', ['overview','users','roles','permissions','audit','disks','raid','lvm','mounts'].includes(active) ? 'max-w-5xl' : 'max-w-2xl']">

        <OverviewSection    v-if="active === 'overview'" />
        <ProfileSection     v-else-if="active === 'profile'" />
        <UserListPanel      v-else-if="active === 'users'" />
        <PlacesSection       v-else-if="active === 'places'" />
        <PermissionsSection  v-else-if="active === 'permissions'" />
        <RolesSection        v-else-if="active === 'roles'" />
        <SystemSection      v-else-if="active === 'system'" />
        <PhysicalDisksSection v-else-if="active === 'disks'"  @navigate="focusOn" />
        <RaidSection          v-else-if="active === 'raid'"   @navigate="focusOn" />
        <LvmSection           v-else-if="active === 'lvm'" />
        <MountsSection        v-else-if="active === 'mounts'" @navigate="focusOn" />
        <UpdateSection      v-else-if="active === 'updates'" />
        <AuditLogSection    v-else-if="active === 'audit'" />

      </div>
    </div>

  </div>
</template>
