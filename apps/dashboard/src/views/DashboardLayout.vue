<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../lib/auth'
import { useUploads } from '../lib/uploads'
import { useNotifications } from '../lib/notifications'
import { trpc } from '../lib/trpc'
import SettingsPanel from '../components/SettingsPanel.vue'
import FileBrowserPanel from '../components/file-browser/FileBrowserPanel.vue'
import AppsPanel from '../components/apps/AppsPanel.vue'
import DashboardPanel from '../components/dashboard/DashboardPanel.vue'
import NotificationsContainer from '../components/NotificationsContainer.vue'
import NotificationMenu from '../components/NotificationMenu.vue'

const router = useRouter()
const { currentUsername, isAdmin, logout } = useAuth()
const uploads = useUploads()
const { notifications } = useNotifications()

const updateAvailable = ref(false)

async function checkUpdateBadge() {
  if (!isAdmin.value) return
  try {
    const s = await trpc.update.status.query()
    updateAvailable.value = s.hasUpdate
  } catch { /* non-critical */ }
}

const activeApp        = ref<string>('dashboard')
const notifMenuOpen    = ref(false)
const userMenuOpen     = ref(false)
const settingsSection  = ref<'profile' | 'users' | 'places' | 'roles' | null>(null)
const appsPanelRef     = ref<InstanceType<typeof AppsPanel> | null>(null)

const badgeCount = computed(() =>
  uploads.tasks.value.filter(t => t.status === 'uploading' || t.status === 'paused').length
  + notifications.value.length
)

const bellRef     = ref<HTMLButtonElement | null>(null)
const notifPos    = ref({ bottom: 16, left: 72 })
const avatarRef   = ref<HTMLButtonElement | null>(null)
const dropdownPos = ref({ bottom: 16, left: 72 })

const initials = computed(() =>
  (currentUsername.value ?? 'U').slice(0, 2).toUpperCase()
)

const activeAppLabel = computed(() => {
  if (activeApp.value === 'dashboard') return 'Overview'
  if (activeApp.value === 'files') return 'Files'
  if (activeApp.value === 'settings') return 'Settings'
  if (activeApp.value === 'apps') return 'Apps'
  return 'Overview'
})

function selectApp(id: string) {
  activeApp.value = id
  userMenuOpen.value = false
  notifMenuOpen.value = false
}

function isActive(id: string) {
  return activeApp.value === id
}

function toggleNotifMenu() {
  if (window.innerWidth < 640) {
    notifPos.value = { bottom: 64, left: 8 }
  } else if (bellRef.value) {
    const rect = bellRef.value.getBoundingClientRect()
    notifPos.value = { bottom: window.innerHeight - rect.bottom, left: rect.right + 8 }
  }
  notifMenuOpen.value = !notifMenuOpen.value
  userMenuOpen.value = false
}

function toggleUserMenu() {
  if (!userMenuOpen.value) {
    if (window.innerWidth < 640) {
      dropdownPos.value = { bottom: 64, left: 8 }
    } else if (avatarRef.value) {
      const rect = avatarRef.value.getBoundingClientRect()
      dropdownPos.value = { bottom: window.innerHeight - rect.bottom, left: rect.right + 8 }
    }
  }
  userMenuOpen.value = !userMenuOpen.value
  notifMenuOpen.value = false
}

function goToProfile() {
  activeApp.value = 'settings'
  settingsSection.value = 'profile'
  userMenuOpen.value = false
}

function handleLogout() {
  logout()
  router.push('/login')
}

function closeUserMenu() {
  userMenuOpen.value = false
}

let updateTimer: ReturnType<typeof setInterval>

onMounted(() => {
  document.addEventListener('click', closeUserMenu)
  checkUpdateBadge()
  updateTimer = setInterval(checkUpdateBadge, 3_600_000) // hourly
})
onUnmounted(() => {
  document.removeEventListener('click', closeUserMenu)
  clearInterval(updateTimer)
})
</script>

<template>
  <div class="flex flex-col sm:flex-row h-screen w-screen bg-[var(--c-bg)]">

    <!-- Sidebar: 64px (desktop only) -->
    <aside class="hidden sm:flex flex-col items-center w-16 bg-[var(--c-sidebar)] border-r border-[var(--c-border)] py-4 flex-shrink-0">

      <!-- Brand mark -->
      <div class="w-8 h-8 rounded-lg bg-[var(--c-accent)] flex items-center justify-center text-[var(--c-accent-fg)] mb-5 select-none">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M12 5l7 7-7 7"/>
        </svg>
      </div>

      <div class="w-8 border-t border-[var(--c-border)] mb-3" />

      <!-- App nav -->
      <nav class="flex flex-col items-stretch gap-1 flex-1 w-full">

        <!-- Dashboard -->
        <div class="relative flex justify-center py-0.5">
          <span
            v-if="isActive('dashboard')"
            class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 bg-[var(--c-accent)] rounded-r-full"
          />
          <button
            @click="selectApp('dashboard')"
            title="Overview"
            :class="[
              'w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150',
              isActive('dashboard')
                ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
                : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]',
            ]"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"/>
            </svg>
          </button>
        </div>

        <!-- Files -->
        <div class="relative flex justify-center py-0.5">
          <span
            v-if="isActive('files')"
            class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 bg-[var(--c-accent)] rounded-r-full"
          />
          <button
            @click="selectApp('files')"
            title="Files"
            :class="[
              'w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150',
              isActive('files')
                ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
                : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]',
            ]"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h3.586a1 1 0 01.707.293L11 7h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
            </svg>
          </button>
        </div>

        <!-- Apps -->
        <div class="relative flex justify-center py-0.5">
          <span
            v-if="isActive('apps')"
            class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 bg-[var(--c-accent)] rounded-r-full"
          />
          <button
            @click="selectApp('apps')"
            title="Apps"
            :class="[
              'w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150',
              isActive('apps')
                ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
                : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]',
            ]"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 12H19M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"/>
            </svg>
          </button>
        </div>

        <!-- Settings -->
        <div class="relative flex justify-center py-0.5">
          <span
            v-if="isActive('settings')"
            class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 bg-[var(--c-accent)] rounded-r-full"
          />
          <button
            @click="selectApp('settings')"
            title="Settings"
            :class="[
              'relative w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150',
              isActive('settings')
                ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
                : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]',
            ]"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span
              v-if="updateAvailable && !isActive('settings')"
              class="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-amber-400"
            />
          </button>
        </div>

      </nav>

      <!-- Notifications bell -->
      <button
        ref="bellRef"
        @click.stop="toggleNotifMenu"
        title="Activity"
        class="relative w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150 mb-2"
        :class="notifMenuOpen
          ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
          : 'text-slate-500 hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]'"
      >
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
        </svg>
        <span
          v-if="badgeCount > 0"
          class="absolute top-1.5 right-1.5 min-w-[14px] h-3.5 px-0.5 bg-[var(--c-accent)] rounded-full text-[8px] font-bold text-[var(--c-accent-fg)] flex items-center justify-center tabular-nums leading-none"
        >{{ badgeCount > 9 ? '9+' : badgeCount }}</span>
      </button>

      <!-- User avatar -->
      <button
        ref="avatarRef"
        @click.stop="toggleUserMenu"
        title="Account"
        class="w-9 h-9 rounded-full bg-[var(--c-accent)] flex items-center
               justify-center text-[var(--c-accent-fg)] text-xs font-bold select-none transition-all duration-150"
        :class="userMenuOpen
          ? 'ring-2 ring-[var(--c-accent)] ring-offset-2 ring-offset-[var(--c-sidebar)]'
          : 'opacity-80 hover:opacity-100'"
      >
        {{ initials }}
      </button>
    </aside>

    <!-- User dropdown -->
    <Teleport to="body">
      <Transition name="menu">
        <div
          v-if="userMenuOpen"
          @click.stop
          class="fixed z-50 bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl shadow-2xl overflow-hidden"
          :style="{
            bottom: dropdownPos.bottom + 'px',
            left: dropdownPos.left + 'px',
            minWidth: '200px',
          }"
        >
          <div class="flex items-center gap-3 px-4 py-3.5 border-b border-[var(--c-border)]">
            <div class="w-8 h-8 rounded-full bg-[var(--c-accent)] flex items-center justify-center text-[var(--c-accent-fg)] text-xs font-bold shrink-0">
              {{ initials }}
            </div>
            <div class="min-w-0">
              <div class="text-[var(--c-text-1)] text-sm font-medium truncate">{{ currentUsername }}</div>
              <div class="text-[var(--c-text-3)] text-xs">{{ isAdmin ? 'Administrator' : 'User' }}</div>
            </div>
          </div>
          <div class="p-1.5">
            <button
              @click="goToProfile"
              class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--c-text-2)]
                     hover:bg-[var(--c-hover)] rounded-lg transition-colors text-left"
            >
              <svg class="w-4 h-4 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              Profile
            </button>
            <div class="h-px bg-[var(--c-border-strong)] mx-1 my-1" />
            <button
              @click="handleLogout"
              class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400
                     hover:bg-red-500/10 rounded-lg transition-colors text-left"
            >
              <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Sign out
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Main area -->
    <main class="flex-1 flex flex-col overflow-hidden">

      <!-- Top bar (hidden for files — FileToolbar acts as the header) -->
      <header v-if="activeApp !== 'files'" class="h-11 flex items-center justify-between px-6 border-b border-[var(--c-border)] flex-shrink-0 bg-[var(--c-surface-alt)]/60 backdrop-blur-sm">
        <span class="text-sm font-medium text-[var(--c-text-2)]">{{ activeAppLabel }}</span>
        <button
          v-if="activeApp === 'apps' && isAdmin"
          @click="appsPanelRef?.openNew()"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--c-accent)] text-[var(--c-accent-fg)] text-xs font-medium rounded-lg hover:opacity-90 transition-opacity"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
          New App
        </button>
      </header>

      <!-- Content -->
      <div :class="['flex-1', activeApp !== 'dashboard' ? 'overflow-hidden' : 'overflow-auto']">
        <DashboardPanel v-if="activeApp === 'dashboard'" class="h-full" />
        <FileBrowserPanel v-else-if="activeApp === 'files'" class="h-full" />
        <AppsPanel v-else-if="activeApp === 'apps'" ref="appsPanelRef" class="h-full" />
        <SettingsPanel v-else-if="activeApp === 'settings'" class="h-full" :focusSection="settingsSection" />
        <div v-else class="flex items-center justify-center h-full text-[var(--c-text-3)] select-none">
          <div class="text-center space-y-3">
            <svg class="w-12 h-12 mx-auto opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
            </svg>
            <p class="text-sm">Select an app from the sidebar</p>
          </div>
        </div>
      </div>

    </main>

    <!-- Mobile bottom nav -->
    <nav class="flex sm:hidden flex-shrink-0 items-center justify-around h-14 bg-[var(--c-sidebar)] border-t border-[var(--c-border)] px-1">

      <!-- Dashboard -->
      <div class="relative flex justify-center">
        <span v-if="isActive('dashboard')"
          class="absolute bottom-0 left-1/2 -translate-x-1/2 w-5 h-0.5 bg-[var(--c-accent)] rounded-t-full" />
        <button @click="selectApp('dashboard')" title="Overview"
          :class="['w-11 h-11 rounded-xl flex items-center justify-center transition-all duration-150',
            isActive('dashboard') ? 'text-[var(--c-accent)]' : 'text-[var(--c-text-3)]']">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"/>
          </svg>
        </button>
      </div>

      <!-- Files -->
      <div class="relative flex justify-center">
        <span v-if="isActive('files')"
          class="absolute bottom-0 left-1/2 -translate-x-1/2 w-5 h-0.5 bg-[var(--c-accent)] rounded-t-full" />
        <button @click="selectApp('files')" title="Files"
          :class="['w-11 h-11 rounded-xl flex items-center justify-center transition-all duration-150',
            isActive('files') ? 'text-[var(--c-accent)]' : 'text-[var(--c-text-3)]']">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h3.586a1 1 0 01.707.293L11 7h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
          </svg>
        </button>
      </div>

      <!-- Apps -->
      <div class="relative flex justify-center">
        <span v-if="isActive('apps')"
          class="absolute bottom-0 left-1/2 -translate-x-1/2 w-5 h-0.5 bg-[var(--c-accent)] rounded-t-full" />
        <button @click="selectApp('apps')" title="Apps"
          :class="['w-11 h-11 rounded-xl flex items-center justify-center transition-all duration-150',
            isActive('apps') ? 'text-[var(--c-accent)]' : 'text-[var(--c-text-3)]']">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 12H19M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"/>
          </svg>
        </button>
      </div>

      <!-- Settings -->
      <div class="relative flex justify-center">
        <span v-if="isActive('settings')"
          class="absolute bottom-0 left-1/2 -translate-x-1/2 w-5 h-0.5 bg-[var(--c-accent)] rounded-t-full" />
        <button @click="selectApp('settings')" title="Settings"
          :class="['relative w-11 h-11 rounded-xl flex items-center justify-center transition-all duration-150',
            isActive('settings') ? 'text-[var(--c-accent)]' : 'text-[var(--c-text-3)]']">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span v-if="updateAvailable && !isActive('settings')"
            class="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-amber-400" />
        </button>
      </div>

      <!-- Notifications bell -->
      <button @click.stop="toggleNotifMenu" title="Activity"
        :class="['relative w-11 h-11 rounded-xl flex items-center justify-center transition-all duration-150',
          notifMenuOpen ? 'text-[var(--c-accent)]' : 'text-[var(--c-text-3)]']">
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
        </svg>
        <span v-if="badgeCount > 0"
          class="absolute top-1.5 right-1.5 min-w-[14px] h-3.5 px-0.5 bg-[var(--c-accent)] rounded-full text-[8px] font-bold text-[var(--c-accent-fg)] flex items-center justify-center tabular-nums leading-none"
        >{{ badgeCount > 9 ? '9+' : badgeCount }}</span>
      </button>

      <!-- User avatar -->
      <button @click.stop="toggleUserMenu" title="Account"
        class="w-9 h-9 rounded-full bg-[var(--c-accent)] flex items-center justify-center text-[var(--c-accent-fg)] text-xs font-bold select-none transition-all duration-150"
        :class="userMenuOpen ? 'ring-2 ring-[var(--c-accent)] ring-offset-2 ring-offset-[var(--c-sidebar)]' : 'opacity-80'">
        {{ initials }}
      </button>

    </nav>

  </div>

  <NotificationsContainer />
  <NotificationMenu
    :open="notifMenuOpen"
    :pos="notifPos"
    @close="notifMenuOpen = false"
  />
</template>

<style scoped>
.menu-enter-active,
.menu-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.menu-enter-from,
.menu-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
