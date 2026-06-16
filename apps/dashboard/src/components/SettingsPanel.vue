<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAuth } from '../lib/auth'
import ProfileSection from './ProfileSection.vue'
import UserListPanel from './UserListPanel.vue'
import PlacesSection from './PlacesSection.vue'
import RolesSection from './RolesSection.vue'
import UpdateSection from './UpdateSection.vue'

const { isAdmin, canManageUsers } = useAuth()

type SectionId = 'profile' | 'users' | 'places' | 'roles' | 'updates'

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
  { id: 'places',      label: 'Places',      show: () => isAdmin.value, group: 'admin' },
  { id: 'roles',       label: 'Roles',       show: () => isAdmin.value, group: 'admin' },
  { id: 'updates',     label: 'Updates',     show: () => isAdmin.value, group: 'admin' },
]

const visibleNav = computed(() => nav.filter(n => n.show()))

function showDivider(item: NavItem, index: number): boolean {
  return item.group === 'admin' && index > 0 && !visibleNav.value[index - 1]?.group
}

const active = ref<SectionId>('profile')

watch(() => props.focusSection, s => { if (s) active.value = s })
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
            <!-- Places icon -->
            <svg v-else-if="item.id === 'places'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h3.586a1 1 0 01.707.293L11 7h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
            </svg>
            <!-- Roles icon -->
            <svg v-else-if="item.id === 'roles'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
            </svg>
            <!-- Updates icon -->
            <svg v-else-if="item.id === 'updates'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
            </svg>
            {{ item.label }}
          </button>
        </div>

      </template>

    </nav>

    <!-- ── Content area ───────────────────────────────────────────────── -->
    <div class="flex-1 overflow-y-auto">
      <div class="p-8 max-w-2xl">

        <ProfileSection     v-if="active === 'profile'" />
        <UserListPanel      v-else-if="active === 'users'" />
        <PlacesSection      v-else-if="active === 'places'" />
        <RolesSection       v-else-if="active === 'roles'" />
        <UpdateSection      v-else-if="active === 'updates'" />

      </div>
    </div>

  </div>
</template>
