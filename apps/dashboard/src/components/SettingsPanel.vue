<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAuth } from '../lib/auth'
import ProfileSection from './ProfileSection.vue'
import UserListPanel from './UserListPanel.vue'
import PlacesSection from './PlacesSection.vue'
import GroupsSection from './GroupsSection.vue'
import UpdateSection from './UpdateSection.vue'
import PermissionsSection from './PermissionsSection.vue'
import SharedLinksSection from './SharedLinksSection.vue'
import BackupSection from './BackupSection.vue'
import DataBackupSection from './DataBackupSection.vue'
import AlertingSection from './AlertingSection.vue'

const { isAdmin, isUserManager } = useAuth()

type SectionId = 'profile' | 'users' | 'places' | 'permissions' | 'groups' | 'updates' | 'alerting' | 'backups' | 'data-backups' | 'shares'

const props = defineProps<{ focusSection?: SectionId | null }>()

type Group = 'access' | 'system' | 'backup'

interface NavItem {
  id: SectionId
  label: string
  show: () => boolean
  group?: Group
}

const GROUP_LABEL: Record<Group, string> = {
  access: 'Access control',
  system: 'System',
  backup: 'Backups',
}

const nav: NavItem[] = [
  { id: 'profile',     label: 'My Profile',  show: () => true },
  { id: 'shares',      label: 'Shared links', show: () => true },
  // Access control: who can reach what. Users is grouped here even though it's
  // gated on isUserManager (not isAdmin like the rest) — a user manager
  // without full admin still needs it alongside the places/perms they manage.
  { id: 'users',       label: 'Users',       show: () => isUserManager.value, group: 'access' },
  { id: 'places',      label: 'Places',      show: () => isAdmin.value, group: 'access' },
  { id: 'permissions', label: 'Permissions', show: () => isAdmin.value, group: 'access' },
  { id: 'groups',      label: 'Groups',      show: () => isAdmin.value, group: 'access' },
  { id: 'updates',     label: 'Updates',     show: () => isAdmin.value, group: 'system' },
  { id: 'alerting',    label: 'Alerting',    show: () => isAdmin.value, group: 'system' },
  { id: 'backups',     label: 'Backup & restore', show: () => isAdmin.value, group: 'backup' },
  { id: 'data-backups', label: 'Data backups', show: () => isAdmin.value, group: 'backup' },
]

const visibleNav = computed(() => nav.filter(n => n.show()))

/** Section label shown above an item's group, only on the group's first visible item. */
function groupHeader(item: NavItem, index: number): string | null {
  if (!item.group) return null
  if (visibleNav.value[index - 1]?.group === item.group) return null
  return GROUP_LABEL[item.group]
}

const active = ref<SectionId>(props.focusSection ?? 'profile')

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

        <!-- Section label above each group's first visible item -->
        <div v-if="groupHeader(item, i)" class="eyebrow px-3 pt-4 pb-1.5">{{ groupHeader(item, i) }}</div>

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
            <!-- Shared links icon -->
            <svg v-else-if="item.id === 'shares'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244"/>
            </svg>
            <!-- Users icon -->
            <svg v-else-if="item.id === 'users'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a4 4 0 00-5.916-3.5M9 20H4v-2a4 4 0 015.916-3.5M15 7a3 3 0 11-6 0 3 3 0 016 0zM21 10a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
            </svg>
            <!-- Places icon -->
            <svg v-else-if="item.id === 'places'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h3.586a1 1 0 01.707.293L11 7h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
            </svg>
            <!-- Permissions icon -->
            <svg v-else-if="item.id === 'permissions'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/>
            </svg>
            <!-- Groups icon -->
            <svg v-else-if="item.id === 'groups'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
            </svg>
            <!-- Updates icon -->
            <svg v-else-if="item.id === 'updates'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
            </svg>
            <!-- Alerting icon -->
            <svg v-else-if="item.id === 'alerting'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
            </svg>
            <!-- Backup icon -->
            <svg v-else-if="item.id === 'backups' || item.id === 'data-backups'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 7.5A2.5 2.5 0 016.5 5h11A2.5 2.5 0 0120 7.5v9a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 16.5v-9zM8 5v5h8V5m-6 10h4"/>
            </svg>
            {{ item.label }}
          </button>
        </div>

      </template>

    </nav>

    <!-- ── Content area ───────────────────────────────────────────────── -->
    <div class="flex-1 overflow-y-auto">
      <div :class="['p-4 sm:p-8', ['users','groups','permissions'].includes(active) ? 'max-w-5xl' : 'max-w-2xl']">

        <ProfileSection     v-if="active === 'profile'" />
        <SharedLinksSection v-else-if="active === 'shares'" />
        <UserListPanel      v-else-if="active === 'users'" />
        <PlacesSection      v-else-if="active === 'places'" />
        <PermissionsSection v-else-if="active === 'permissions'" />
        <GroupsSection      v-else-if="active === 'groups'" />
        <UpdateSection      v-else-if="active === 'updates'" />
        <AlertingSection    v-else-if="active === 'alerting'" />
        <BackupSection      v-else-if="active === 'backups'" />
        <DataBackupSection  v-else-if="active === 'data-backups'" />

      </div>
    </div>

  </div>
</template>
