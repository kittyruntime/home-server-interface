<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../lib/auth'
import { useUploads } from '../lib/uploads'
import { useNotifications } from '../lib/notifications'
import { useDesktop } from '../lib/desktop'
import { trpc } from '../lib/trpc'
import FileBrowserPanel from '../components/file-browser/FileBrowserPanel.vue'
import DashboardPanel from '../components/dashboard/DashboardPanel.vue'
import SidebarNavIcon from '../components/desktop/SidebarNavIcon.vue'
import { useSidebarNav, orderedIds, reorder, persistOrder, resetOrder } from '../lib/sidebar-nav'
// Dashboard + Files stay eager (default view / most-used); the rest split into
// their own chunks and load when their app is first opened.
import type AppsPanelT from '../components/apps/AppsPanel.vue'
const SettingsPanel = defineAsyncComponent(() => import('../components/SettingsPanel.vue'))
const StoragePanel = defineAsyncComponent(() => import('../components/storage/StoragePanel.vue'))
const AppStorePanel = defineAsyncComponent(() => import('../components/store/AppStorePanel.vue'))
const MonitorPanel = defineAsyncComponent(() => import('../components/monitor/MonitorPanel.vue'))
const AppsPanel = defineAsyncComponent(() => import('../components/apps/AppsPanel.vue'))
const SharingPanel = defineAsyncComponent(() => import('../components/sharing/SharingPanel.vue'))
import NotificationMenu from '../components/NotificationMenu.vue'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
import ToastContainer from '../components/ui/ToastContainer.vue'
import Dock from '../components/desktop/Dock.vue'
import Launchpad from '../components/desktop/Launchpad.vue'
import DesktopShell from '../components/desktop/DesktopShell.vue'

const router = useRouter()
const { currentUsername, isAdmin, logout } = useAuth()
const uploads = useUploads()
const { notifications } = useNotifications()
const { desktopMode, setDesktopMode, openApp } = useDesktop()

const isMobile = ref(window.innerWidth < 640)
const launchpadOpen = ref(false)

function updateIsMobile() {
  isMobile.value = window.innerWidth < 640
}

const updateAvailable = ref(false)

async function checkUpdateBadge() {
  if (!isAdmin.value) return
  try {
    const s = await trpc.update.status.query()
    updateAvailable.value = s.hasUpdate
  } catch { /* non-critical */ }
}

// Default-credentials nudge: shown once per session (re-checked on every boot)
// until the account moves off the seeded default password.
const usingDefaultPassword = ref(false)
const defaultPwDismissed = ref(false)

async function checkDefaultPassword() {
  try {
    const s = await trpc.user.securityStatus.query()
    usingDefaultPassword.value = s.usingDefaultPassword
  } catch { /* non-critical */ }
}

const activeApp        = ref<string>('dashboard')
const notifMenuOpen    = ref(false)
const userMenuOpen     = ref(false)
const settingsSection  = ref<'profile' | 'users' | 'places' | 'roles' | null>(null)
const appsPanelRef     = ref<InstanceType<typeof AppsPanelT> | null>(null)

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
  if (activeApp.value === 'storage') return 'Storage'
  if (activeApp.value === 'store') return 'App Store'
  if (activeApp.value === 'monitor') return 'Monitor'
  if (activeApp.value === 'sharing') return 'Sharing'
  return 'Overview'
})

function selectApp(id: string) {
  activeApp.value = id
  userMenuOpen.value = false
  notifMenuOpen.value = false
}

// Data-driven, user-orderable sidebar / mobile nav (order persisted per-browser).
const { items: navItems } = useSidebarNav(() => isAdmin.value)

// Native drag-and-drop reorder (desktop sidebar only). Operates on the full
// ordered id list so hidden admin items keep their relative position.
const draggingId = ref<string | null>(null)
function onNavDragStart(id: string, e: DragEvent) {
  draggingId.value = id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
}
function onNavDragOver(overId: string, e: DragEvent) {
  const dragId = draggingId.value
  if (!dragId || dragId === overId) return
  const full = [...orderedIds.value]
  const from = full.indexOf(dragId)
  if (from === -1 || full.indexOf(overId) === -1) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const after = e.clientY > rect.top + rect.height / 2
  full.splice(from, 1)
  const to = full.indexOf(overId)
  full.splice(after ? to + 1 : to, 0, dragId)
  reorder(full)
}
function onNavDragEnd() {
  if (draggingId.value) persistOrder()
  draggingId.value = null
}
function resetSidebarOrder() {
  resetOrder()
  userMenuOpen.value = false
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
  if (desktopMode.value && !isMobile.value) {
    openApp('settings', 'profile')
  } else {
    activeApp.value = 'settings'
    settingsSection.value = 'profile'
  }
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
  window.addEventListener('resize', updateIsMobile)
  checkUpdateBadge()
  checkDefaultPassword()
  updateTimer = setInterval(checkUpdateBadge, 3_600_000) // hourly
})
onUnmounted(() => {
  document.removeEventListener('click', closeUserMenu)
  window.removeEventListener('resize', updateIsMobile)
  clearInterval(updateTimer)
})
</script>

<template>
  <!-- Single root wrapper: required so the route <Transition> in App.vue can
       animate this view and its style fallthrough (--ui-dur) merges here. -->
  <div>
  <div class="flex flex-col sm:flex-row h-screen w-screen bg-[var(--c-bg)]">

    <!-- Sidebar: 64px (desktop only) -->
    <aside class="hidden sm:flex flex-col items-center w-16 bg-[var(--c-sidebar)] border-r border-[var(--c-border)] py-4 flex-shrink-0">

      <template v-if="desktopMode && !isMobile">
        <Dock class="flex-1" @open-launchpad="launchpadOpen = true" />
      </template>
      <template v-else>
        <!-- Brand mark -->
        <div class="w-8 h-8 rounded-lg bg-[var(--c-accent)] flex items-center justify-center text-[var(--c-accent-fg)] mb-5 select-none">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
        </div>

        <div class="w-8 border-t border-[var(--c-border)] mb-3" />

        <!-- App nav (drag an icon to reorder — persisted per browser) -->
        <nav class="flex flex-col items-stretch gap-1 flex-1 w-full">
          <div
            v-for="item in navItems"
            :key="item.id"
            draggable="true"
            @dragstart="onNavDragStart(item.id, $event)"
            @dragover.prevent="onNavDragOver(item.id, $event)"
            @dragend="onNavDragEnd"
            @drop.prevent="onNavDragEnd"
            :class="['relative flex justify-center py-0.5 transition-opacity', draggingId === item.id ? 'opacity-40' : '']"
          >
            <span
              v-if="isActive(item.id)"
              class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 bg-[var(--c-accent)] rounded-r-full"
            />
            <button
              @click="selectApp(item.id)"
              :title="item.label"
              :class="[
                'relative w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150',
                isActive(item.id)
                  ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
                  : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]',
              ]"
            >
              <SidebarNavIcon :id="item.id" />
              <span
                v-if="item.id === 'settings' && updateAvailable && !isActive('settings')"
                class="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[var(--c-warning)]"
              />
            </button>
          </div>
        </nav>
      </template>

      <!-- Notifications bell -->
      <button
        ref="bellRef"
        @click.stop="toggleNotifMenu"
        title="Activity"
        class="relative w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-150 mb-2"
        :class="notifMenuOpen
          ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
          : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]'"
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
          class="fixed z-50 bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl overflow-hidden"
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
            <div class="w-full flex items-center justify-between gap-2.5 px-3 py-2 text-sm text-[var(--c-text-2)]">
              <span class="flex items-center gap-2.5">
                <svg class="w-4 h-4 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                </svg>
                Desktop mode
              </span>
              <button
                @click="setDesktopMode(!desktopMode)"
                role="switch"
                :aria-checked="desktopMode"
                title="Toggle desktop mode"
                :class="['relative w-9 h-5 rounded-full transition-colors shrink-0', desktopMode ? 'bg-[var(--c-accent)]' : 'bg-[var(--c-border-strong)]']"
              >
                <span :class="['absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white transition-transform', desktopMode ? 'translate-x-4' : 'translate-x-0']" />
              </button>
            </div>
            <button
              @click="resetSidebarOrder"
              class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--c-text-2)]
                     hover:bg-[var(--c-hover)] rounded-lg transition-colors text-left"
            >
              <svg class="w-4 h-4 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Reset sidebar order
            </button>
            <div class="h-px bg-[var(--c-border-strong)] mx-1 my-1" />
            <button
              @click="handleLogout"
              class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--c-accent)]
                     hover:bg-[var(--c-accent-subtle)] rounded-lg transition-colors text-left"
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
      <!-- Default-password warning: dismissible, links straight to the profile
           where the password can be changed. -->
      <div
        v-if="usingDefaultPassword && !defaultPwDismissed"
        class="flex items-center gap-3 px-4 sm:px-6 py-2 bg-[var(--c-warning-subtle)] border-b border-[var(--c-border)] text-sm flex-shrink-0"
      >
        <svg class="w-4 h-4 shrink-0 text-[var(--c-warning)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
        <span class="text-[var(--c-text-1)] flex-1 min-w-0">
          You're signed in with the default password.
          <button @click="goToProfile" class="font-medium underline underline-offset-2 hover:opacity-80">Change it now</button>
          to keep your server secure.
        </span>
        <button
          @click="defaultPwDismissed = true"
          title="Dismiss"
          class="shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)] transition-colors"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <DesktopShell v-if="desktopMode && !isMobile" />
      <template v-else>
        <!-- Top bar (hidden for files — FileToolbar acts as the header) -->
        <header v-if="activeApp !== 'files'" class="h-11 flex items-center justify-between px-6 border-b border-[var(--c-border)] flex-shrink-0 bg-[var(--c-surface-alt)]">
          <span class="eyebrow">{{ activeAppLabel }}</span>
          <button
            v-if="activeApp === 'apps' && isAdmin"
            @click="appsPanelRef?.openNew()"
            class="btn btn-primary btn-xs"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
            </svg>
            New App
          </button>
        </header>

        <!-- Content — the keyed wrapper (not the panels: FileBrowserPanel is
             multi-root) cross-fades on app switch, like routes do. -->
        <div :class="['flex-1', activeApp !== 'dashboard' ? 'overflow-hidden' : 'overflow-auto']">
          <Transition name="ui-fade" mode="out-in">
          <div :key="activeApp" class="h-full route-fade">
          <DashboardPanel v-if="activeApp === 'dashboard'" class="h-full" />
          <FileBrowserPanel v-else-if="activeApp === 'files'" class="h-full" />
          <AppsPanel v-else-if="activeApp === 'apps'" ref="appsPanelRef" class="h-full" />
          <SettingsPanel v-else-if="activeApp === 'settings'" class="h-full" :focusSection="settingsSection" />
          <StoragePanel v-else-if="activeApp === 'storage'" class="h-full" />
          <AppStorePanel v-else-if="activeApp === 'store'" class="h-full" />
          <MonitorPanel v-else-if="activeApp === 'monitor'" class="h-full" />
          <SharingPanel v-else-if="activeApp === 'sharing'" class="h-full" />
          <div v-else class="flex items-center justify-center h-full text-[var(--c-text-3)] select-none">
            <div class="text-center space-y-3">
              <svg class="w-12 h-12 mx-auto opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
              </svg>
              <p class="text-sm">Select an app from the sidebar</p>
            </div>
          </div>
          </div>
          </Transition>
        </div>
      </template>
    </main>

    <!-- Mobile bottom nav -->
    <nav class="flex sm:hidden flex-shrink-0 items-center justify-around h-14 bg-[var(--c-sidebar)] border-t border-[var(--c-border)] px-1">

      <!-- App nav (order mirrors the sidebar; not draggable on mobile) -->
      <div v-for="item in navItems" :key="item.id" class="relative flex justify-center">
        <span v-if="isActive(item.id)"
          class="absolute bottom-0 left-1/2 -translate-x-1/2 w-5 h-0.5 bg-[var(--c-accent)] rounded-t-full" />
        <button @click="selectApp(item.id)" :title="item.label"
          :class="['relative w-11 h-11 rounded-xl flex items-center justify-center transition-all duration-150',
            isActive(item.id) ? 'text-[var(--c-accent)]' : 'text-[var(--c-text-3)]']">
          <SidebarNavIcon :id="item.id" />
          <span v-if="item.id === 'settings' && updateAvailable && !isActive('settings')"
            class="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[var(--c-warning)]" />
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

  <ToastContainer />
  <ConfirmDialog />
  <NotificationMenu
    :open="notifMenuOpen"
    :pos="notifPos"
    @close="notifMenuOpen = false"
  />
  <Launchpad v-if="launchpadOpen" @close="launchpadOpen = false" />
  </div>
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
