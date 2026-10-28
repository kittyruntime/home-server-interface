<script setup lang="ts">
import SectionNav from '@/components/ui/SectionNav.vue'
import { BellIcon, ChartNoAxesColumnIcon, FolderIcon, LinkIcon, LockIcon, SaveIcon, ShieldCheckIcon, TriangleAlertIcon, UploadIcon, UserIcon, UsersIcon } from '@lucide/vue'
import { ref, computed, watch } from 'vue'
import type { Component } from 'vue'
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
import NotificationsSection from './NotificationsSection.vue'
import SecureAccessSection from './SecureAccessSection.vue'
import TelemetrySection from './TelemetrySection.vue'

const { isAdmin, isUserManager } = useAuth()

type SectionId = 'profile' | 'users' | 'places' | 'permissions' | 'groups' | 'updates' | 'alerting' | 'notifications' | 'secure' | 'telemetry' | 'backups' | 'data-backups' | 'shares'

const props = defineProps<{ focusSection?: SectionId | null }>()

type Group = 'account' | 'access' | 'system' | 'backup'

interface NavItem {
  id: SectionId
  label: string
  show: () => boolean
  group?: Group
}

const GROUP_LABEL: Record<Group, string> = {
  account: 'Account',
  access: 'Access control',
  system: 'System',
  backup: 'Backups',
}

const nav: NavItem[] = [
  { id: 'profile',     label: 'My profile',  show: () => true,  group: 'account' },
  { id: 'shares',      label: 'Shared links', show: () => true, group: 'account' },
  // Access control: who can reach what. Users is grouped here even though it's
  // gated on isUserManager (not isAdmin like the rest): a user manager
  // without full admin still needs it alongside the places/perms they manage.
  { id: 'users',       label: 'Users',       show: () => isUserManager.value, group: 'access' },
  { id: 'places',      label: 'Places',      show: () => isAdmin.value, group: 'access' },
  { id: 'permissions', label: 'Permissions', show: () => isAdmin.value, group: 'access' },
  { id: 'groups',      label: 'Groups',      show: () => isAdmin.value, group: 'access' },
  { id: 'alerting',    label: 'Alert thresholds', show: () => isAdmin.value, group: 'system' },
  { id: 'notifications', label: 'Notifications', show: () => isAdmin.value, group: 'system' },
  { id: 'secure',      label: 'Secure access', show: () => isAdmin.value, group: 'system' },
  { id: 'updates',     label: 'Updates',     show: () => isAdmin.value, group: 'system' },
  { id: 'telemetry',   label: 'Telemetry',   show: () => isAdmin.value, group: 'system' },
  { id: 'backups',     label: 'Backup & restore', show: () => isAdmin.value, group: 'backup' },
  { id: 'data-backups', label: 'Data backups', show: () => isAdmin.value, group: 'backup' },
]

const visibleNav = computed(() => nav.filter(n => n.show()))

const active = ref<SectionId>(props.focusSection ?? 'profile')

watch(() => props.focusSection, s => { if (s) active.value = s })

function focusOn(section: SectionId) {
  active.value = section
}

defineExpose({ focusOn })

const ICONS: Record<SectionId, Component> = {
  profile: UserIcon, shares: LinkIcon, users: UsersIcon, places: FolderIcon,
  permissions: LockIcon, groups: ShieldCheckIcon, alerting: TriangleAlertIcon,
  notifications: BellIcon, secure: LockIcon, updates: UploadIcon, telemetry: ChartNoAxesColumnIcon,
  backups: SaveIcon, 'data-backups': SaveIcon,
}
const navItems = computed(() => visibleNav.value.map(n => ({
  id: n.id, label: n.label, icon: ICONS[n.id], group: n.group && GROUP_LABEL[n.group],
})))
</script>

<template>
  <div class="flex flex-col sm:flex-row h-full">

    <SectionNav v-model="active" :items="navItems" />

    <!-- ── Content area ───────────────────────────────────────────────── -->
    <div class="flex-1 overflow-y-auto">
      <div :class="['p-4 sm:p-8', ['users','groups','permissions'].includes(active) ? 'max-w-5xl' : 'max-w-2xl']">

        <ProfileSection     v-if="active === 'profile'" />
        <SharedLinksSection v-else-if="active === 'shares'" />
        <UserListPanel      v-else-if="active === 'users'" />
        <PlacesSection      v-else-if="active === 'places'" />
        <PermissionsSection v-else-if="active === 'permissions'" />
        <GroupsSection      v-else-if="active === 'groups'" />
        <SecureAccessSection v-else-if="active === 'secure'" />
        <TelemetrySection v-else-if="active === 'telemetry'" />
        <UpdateSection      v-else-if="active === 'updates'" />
        <AlertingSection    v-else-if="active === 'alerting'" />
        <NotificationsSection v-else-if="active === 'notifications'" />
        <BackupSection      v-else-if="active === 'backups'" />
        <DataBackupSection  v-else-if="active === 'data-backups'" />

      </div>
    </div>

  </div>
</template>
