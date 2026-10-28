<script setup lang="ts">
import { BellIcon, FolderIcon, LinkIcon, LockIcon, SaveIcon, ShieldCheckIcon, TriangleAlertIcon, UploadIcon, UserIcon, UsersIcon } from '@lucide/vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
import NotificationsSection from './NotificationsSection.vue'
import SecureAccessSection from './SecureAccessSection.vue'

const { isAdmin, isUserManager } = useAuth()

type SectionId = 'profile' | 'users' | 'places' | 'permissions' | 'groups' | 'updates' | 'alerting' | 'notifications' | 'secure' | 'backups' | 'data-backups' | 'shares'

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
    <div class="sm:hidden flex-shrink-0 border-b border-border bg-sidebar px-4 py-2.5">
      <Select v-model="active">
        <SelectTrigger class="w-full" aria-label="Section">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="item in visibleNav" :key="item.id" :value="item.id">{{ item.label }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <!-- ── Left nav ───────────────────────────────────────────────────── -->
    <nav class="hidden sm:flex w-48 flex-shrink-0 border-r border-border bg-sidebar py-5 px-2 flex-col gap-0.5 overflow-y-auto">

      <template v-for="(item, i) in visibleNav" :key="item.id">

        <!-- Section label above each group's first visible item -->
        <div v-if="groupHeader(item, i)" class="eyebrow px-3 pt-4 pb-1.5">{{ groupHeader(item, i) }}</div>

        <div class="relative flex items-center">
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
            <!-- Profile icon -->
            <UserIcon v-if="item.id === 'profile'" class="w-4 h-4 shrink-0" aria-hidden="true" />
            <!-- Shared links icon -->
            <LinkIcon v-else-if="item.id === 'shares'" class="w-4 h-4 shrink-0" aria-hidden="true" />
            <!-- Users icon -->
            <UsersIcon v-else-if="item.id === 'users'" class="w-4 h-4 shrink-0" aria-hidden="true" />
            <!-- Places icon -->
            <FolderIcon v-else-if="item.id === 'places'" class="w-4 h-4 shrink-0" aria-hidden="true" />
            <!-- Permissions icon -->
            <LockIcon v-else-if="item.id === 'permissions'" class="w-4 h-4 shrink-0" aria-hidden="true" />
            <!-- Groups icon -->
            <ShieldCheckIcon v-else-if="item.id === 'groups'" class="w-4 h-4 shrink-0" aria-hidden="true" />
            <!-- Secure access icon -->
            <LockIcon v-else-if="item.id === 'secure'" class="w-4 h-4 shrink-0" aria-hidden="true" />
            <!-- Updates icon -->
            <UploadIcon v-else-if="item.id === 'updates'" class="w-4 h-4 shrink-0" aria-hidden="true" />
            <!-- Alerting icon -->
            <TriangleAlertIcon v-else-if="item.id === 'alerting'" class="w-4 h-4 shrink-0" aria-hidden="true" />
            <!-- Notifications icon -->
            <BellIcon v-else-if="item.id === 'notifications'" class="w-4 h-4 shrink-0" aria-hidden="true" />
            <!-- Backup icon -->
            <SaveIcon v-else-if="item.id === 'backups' || item.id === 'data-backups'" class="w-4 h-4 shrink-0" aria-hidden="true" />
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
        <SecureAccessSection v-else-if="active === 'secure'" />
        <UpdateSection      v-else-if="active === 'updates'" />
        <AlertingSection    v-else-if="active === 'alerting'" />
        <NotificationsSection v-else-if="active === 'notifications'" />
        <BackupSection      v-else-if="active === 'backups'" />
        <DataBackupSection  v-else-if="active === 'data-backups'" />

      </div>
    </div>

  </div>
</template>
