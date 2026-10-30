<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { ref, computed, watch, onMounted, onUnmounted, nextTick, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '../lib/auth'
import { useAlerts } from '../composables/useAlerts'
import { useDesktop } from '../lib/desktop'
import { pendingAppFocus } from '../lib/app-focus'
import { pendingStorageLocation } from '../lib/storage-open'
import { useSystemNotifications } from '../lib/systemNotifications'
import { useNotifications } from '../lib/notifications'
import { trpc } from '../lib/trpc'
import FileBrowserPanel from '../components/file-browser/FileBrowserPanel.vue'
import DashboardPanel from '../components/dashboard/DashboardPanel.vue'
import SidebarNavIcon from '../components/desktop/SidebarNavIcon.vue'
import { useSidebarNav, orderedIds, reorder, persistOrder, setOrder, resetOrder } from '../lib/sidebar-nav'
import { syncPreferences } from '../lib/preferences'
import { appFromQuery, appQuery } from '../lib/app-route'
// Dashboard + Files stay eager (default view / most-used); the rest split into
// their own chunks and load when their app is first opened.
import type AppsPanelT from '../components/apps/AppsPanel.vue'
const SettingsPanel = defineAsyncComponent(() => import('../components/SettingsPanel.vue'))
const StoragePanel = defineAsyncComponent(() => import('../components/storage/StoragePanel.vue'))
const AppStorePanel = defineAsyncComponent(() => import('../components/store/AppStorePanel.vue'))
const MonitorPanel = defineAsyncComponent(() => import('../components/monitor/MonitorPanel.vue'))
const AppsPanel = defineAsyncComponent(() => import('../components/apps/AppsPanel.vue'))
const SharingPanel = defineAsyncComponent(() => import('../components/sharing/SharingPanel.vue'))
const AssistantPanel = defineAsyncComponent(() => import('../components/assistant/AssistantPanel.vue'))
import AccountMenu from '../components/AccountMenu.vue'
import ActivityPopover from '../components/ActivityPopover.vue'
import AgentRequests from '../components/AgentRequests.vue'
import { navCapability, refreshAssistantStatus } from '../lib/assistant'
import ConfirmDialog from '../components/ui/ConfirmDialog.vue'
import PlanDialog from '../components/ui/PlanDialog.vue'
import JobLogsDialog from '../components/JobLogsDialog.vue'
import { Toaster } from '@/components/ui/sonner'
import { maintenance } from '../lib/maintenance'
import Dock from '../components/desktop/Dock.vue'
import Launchpad from '../components/desktop/Launchpad.vue'
import DesktopShell from '../components/desktop/DesktopShell.vue'
import { ArrowRightIcon, BellIcon, EllipsisIcon, LayoutGridIcon, PlusIcon, TriangleAlertIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const { t } = useI18n()

const router = useRouter()
const route = useRoute()
const { isAdmin, mustChangePassword, logout } = useAuth()
const { alerts, hasAlerts } = useAlerts()
const { desktopMode, openApp } = useDesktop()
const { unread } = useSystemNotifications()
const { notifications: operations } = useNotifications()

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

const activeApp        = ref<string>('dashboard')
const settingsSection  = ref<'profile' | 'users' | 'places' | 'groups' | 'data-backups' | 'secure' | null>(null)
const appsPanelRef     = ref<InstanceType<typeof AppsPanelT> | null>(null)

// Unread system notifications plus operations that are running or failed.
const badgeCount = computed(() => unread.value + operations.value.filter(n => n.type === 'progress' || n.type === 'error').length)

// Storage opened on a location from elsewhere (#40): the panel navigates.
watch(pendingStorageLocation, loc => {
  if (!loc) return
  if (desktopMode.value && !isMobile.value) openApp('storage')
  else activeApp.value = 'storage'
})

// A freshly installed app is shown in Apps (#36).
watch(pendingAppFocus, name => {
  if (!name) return
  if (desktopMode.value && !isMobile.value) openApp('apps')
  else activeApp.value = 'apps'
})

const activeAppLabel = computed(() => {
  if (activeApp.value === 'dashboard') return t('uis.views.DashboardLayout.overview')
  if (activeApp.value === 'files') return t('uis.views.DashboardLayout.files')
  if (activeApp.value === 'settings') return t('uis.views.DashboardLayout.settings')
  if (activeApp.value === 'apps') return t('uis.views.DashboardLayout.apps')
  if (activeApp.value === 'storage') return t('uis.views.DashboardLayout.storage')
  if (activeApp.value === 'store') return t('uis.views.DashboardLayout.appStore')
  if (activeApp.value === 'monitor') return t('uis.views.DashboardLayout.monitor')
  if (activeApp.value === 'sharing') return t('uis.views.DashboardLayout.sharing')
  if (activeApp.value === 'assistant') return t('apps.assistant')
  return t('uis.views.DashboardLayout.overview')
})

function selectApp(id: string) {
  activeApp.value = id
}

// Data-driven, user-orderable sidebar / mobile nav (order persisted per-browser).
const { items: navItems } = useSidebarNav(() => isAdmin.value, navCapability)

// The open app is in the URL (?app=storage, #90): a reload or a link opens it
// again, and the browser's back button returns to the previous app.
const allowedApps = () => navItems.value.map(item => item.id)
activeApp.value = appFromQuery(route.query.app, allowedApps())
watch(activeApp, id => {
  if ((route.query.app ?? 'dashboard') !== id) void router.push({ query: appQuery(route.query, id) as Record<string, string> })
})
watch(() => route.query.app, app => {
  const id = appFromQuery(app, allowedApps())
  if (id !== activeApp.value) activeApp.value = id
})
const mobilePrimaryItems = computed(() => {
  const primary = navItems.value.slice(0, 4)
  const active = navItems.value.find(item => item.id === activeApp.value)
  if (active && !primary.some(item => item.id === active.id)) primary.splice(3, 1, active)
  return primary
})
const mobileMoreItems = computed(() => navItems.value.filter(item => !mobilePrimaryItems.value.some(primary => primary.id === item.id)))

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
// Keyboard reorder (drag isn't keyboard-accessible): Alt+ArrowUp/Down moves the
// focused item past its previous/next visible sibling. Operates on the full order
// so hidden admin items keep their positions.
function moveNavItem(id: string, dir: -1 | 1) {
  const visible = navItems.value.map(i => i.id)
  const vi = visible.indexOf(id)
  const target = vi + dir
  if (vi === -1 || target < 0 || target >= visible.length) return
  const targetId = visible[target]
  if (targetId === undefined) return
  const full = [...orderedIds.value]
  full.splice(full.indexOf(id), 1)
  const to = full.indexOf(targetId)
  full.splice(dir > 0 ? to + 1 : to, 0, id)
  setOrder(full)
  nextTick(() => document.querySelector<HTMLElement>(`[data-nav-id="${id}"]`)?.focus())
}
function onNavKeydown(id: string, e: KeyboardEvent) {
  if (!e.altKey) return
  if (e.key === 'ArrowUp')   { e.preventDefault(); moveNavItem(id, -1) }
  if (e.key === 'ArrowDown') { e.preventDefault(); moveNavItem(id,  1) }
}
function resetSidebarOrder() {
  resetOrder()
}

function isActive(id: string) {
  return activeApp.value === id
}

function onDashboardNavigate(target: 'places' | 'store' | 'backups' | 'secure') {
  if (target === 'store') {
    activeApp.value = 'store'
    return
  }
  activeApp.value = 'settings'
  settingsSection.value = target === 'places' ? 'places' : target === 'secure' ? 'secure' : 'data-backups'
}

function goToProfile() {
  if (desktopMode.value && !isMobile.value) {
    openApp('settings', 'profile')
  } else {
    activeApp.value = 'settings'
    settingsSection.value = 'profile'
  }
}

function handleLogout() {
  logout()
  router.push('/login')
}

let updateTimer: ReturnType<typeof setInterval>

onMounted(() => {
  window.addEventListener('resize', updateIsMobile)
  checkUpdateBadge()
  syncPreferences()
  void refreshAssistantStatus()
  updateTimer = setInterval(checkUpdateBadge, 3_600_000) // hourly
})
onUnmounted(() => {
  window.removeEventListener('resize', updateIsMobile)
  clearInterval(updateTimer)
})
</script>

<template>
  <!-- Single root wrapper: required so the route <Transition> in App.vue can
       animate this view and its style fallthrough (--ui-dur) merges here. -->
  <div>
  <div class="flex h-[100dvh] w-full max-w-full flex-col overflow-hidden bg-background sm:flex-row">

    <!-- Sidebar: 64px (desktop only) -->
    <aside class="hidden sm:flex flex-col items-center w-16 bg-sidebar text-sidebar-foreground border-r border-sidebar-border py-4 flex-shrink-0">

      <template v-if="desktopMode && !isMobile">
        <Dock class="flex-1" @open-launchpad="launchpadOpen = true" />
      </template>
      <template v-else>
        <!-- Brand mark -->
        <div class="size-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground mb-5 select-none">
          <ArrowRightIcon class="size-4" />
        </div>

        <div class="w-8 border-t border-sidebar-border mb-3" />

        <!-- App nav (drag an icon to reorder, persisted per browser) -->
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
              class="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 bg-primary rounded-r-full"
            />
            <Tooltip>
              <TooltipTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon-lg"
                  @click="selectApp(item.id)"
                  @keydown="onNavKeydown(item.id, $event)"
                  :data-nav-id="item.id"
                  :aria-label="item.label"
                  :aria-current="isActive(item.id) ? 'page' : undefined"
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  :class="[
                    'relative rounded-xl [&_svg:not([class*=size-])]:size-5',
                    isActive(item.id)
                      ? 'bg-sidebar-accent text-primary hover:bg-sidebar-accent hover:text-primary'
                      : 'text-muted-foreground hover:text-sidebar-accent-foreground',
                  ]"
                >
                  <SidebarNavIcon :id="item.id" />
                  <span
                    v-if="item.id === 'settings' && updateAvailable && !isActive('settings')"
                    class="absolute top-1.5 right-1.5 size-2 rounded-full bg-warning"
                  />
                  <span
                    v-if="item.id === 'storage' && hasAlerts('storage.') && !isActive('storage')"
                    class="absolute top-1.5 right-1.5 size-2 rounded-full bg-destructive"
                  />
                  <span
                    v-if="item.id === 'monitor' && alerts.length && !isActive('monitor')"
                    class="absolute top-1.5 right-1.5 size-2 rounded-full bg-destructive"
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{{ item.label }}</TooltipContent>
            </Tooltip>
          </div>
        </nav>
      </template>

      <!-- Notifications bell -->
      <ActivityPopover v-if="!isMobile" side="right">
        <Button
          variant="ghost"
          size="icon-lg"
          :aria-label="t('ui.views.DashboardLayout.activity')"
          :tooltip="t('ui.views.DashboardLayout.activity')"
          class="relative mb-2 rounded-xl text-muted-foreground hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-primary [&_svg:not([class*=size-])]:size-5"
        >
          <BellIcon />
          <span
            v-if="badgeCount > 0"
            class="absolute top-1.5 right-1.5 min-w-[14px] h-3.5 px-0.5 bg-primary rounded-full text-2xs font-bold text-primary-foreground flex items-center justify-center tabular-nums leading-none"
          >{{ badgeCount > 9 ? '9+' : badgeCount }}</span>
        </Button>
      </ActivityPopover>

      <!-- User avatar -->
      <AccountMenu v-if="!isMobile" side="right" @profile="goToProfile" @reset-order="resetSidebarOrder" @logout="handleLogout">
        <template #default="{ initials }">
          <Button
            variant="ghost"
            size="icon"
            :aria-label="t('ui.views.DashboardLayout.account')"
            class="group size-9 rounded-full p-0 select-none hover:bg-transparent"
          >
            <Avatar class="size-9 overflow-visible text-xs opacity-80 transition-all duration-150 group-hover:opacity-100 group-data-[state=open]:opacity-100 group-data-[state=open]:ring-2 group-data-[state=open]:ring-primary group-data-[state=open]:ring-offset-2 group-data-[state=open]:ring-offset-sidebar">
              <AvatarFallback class="bg-primary font-bold text-primary-foreground">{{ initials }}</AvatarFallback>
            </Avatar>
          </Button>
        </template>
      </AccountMenu>
    </aside>

    <!-- Main area -->
    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <!-- Forced password change: this account was created with its password still
           at the value it was seeded with. Not dismissible: the server refuses
           every other mutation until it's changed (see blockIfMustChangePassword
           in trpc/index.ts), so leaving this open to close would just be confusing. -->
      <div
        v-if="mustChangePassword"
        class="flex items-center gap-3 px-4 sm:px-6 py-2 bg-warning/15 border-b text-sm flex-shrink-0"
      >
        <TriangleAlertIcon class="size-4 shrink-0 text-warning" />
        <span class="text-foreground flex-1 min-w-0">
          {{ t('ui.views.DashboardLayout.youMustChangeYourPassword') }}
          <Button variant="link" class="h-auto p-0 font-medium text-foreground underline" @click="goToProfile">{{ t('ui.views.DashboardLayout.changeItNow') }}</Button>
        </span>
      </div>
      <DesktopShell v-if="desktopMode && !isMobile" />
      <template v-else>
        <!-- Top bar (hidden for files: FileToolbar acts as the header) -->
        <header v-if="activeApp !== 'files'" class="h-11 flex items-center justify-between px-4 sm:px-6 border-b flex-shrink-0 bg-muted">
          <span class="eyebrow">{{ activeAppLabel }}</span>
          <Button
            v-if="activeApp === 'apps' && isAdmin"
            size="xs"
            @click="appsPanelRef?.openNew()"
          >
            <PlusIcon />
            {{ t('ui.views.DashboardLayout.newApp') }}
          </Button>
        </header>

        <!-- Content: the keyed wrapper (not the panels: FileBrowserPanel is
             multi-root) cross-fades on app switch, like routes do. -->
        <div :class="['min-w-0 flex-1', activeApp !== 'dashboard' ? 'overflow-hidden' : 'overflow-auto']">
          <Transition name="ui-fade" mode="out-in">
          <div :key="activeApp" class="mobile-density h-full route-fade">
          <DashboardPanel v-if="activeApp === 'dashboard'" class="h-full" @navigate="onDashboardNavigate" />
          <FileBrowserPanel v-else-if="activeApp === 'files'" class="h-full" />
          <AppsPanel v-else-if="activeApp === 'apps'" ref="appsPanelRef" class="h-full" />
          <SettingsPanel v-else-if="activeApp === 'settings'" class="h-full" :focusSection="settingsSection" />
          <StoragePanel v-else-if="activeApp === 'storage'" class="h-full" />
          <AppStorePanel v-else-if="activeApp === 'store'" class="h-full" />
          <MonitorPanel v-else-if="activeApp === 'monitor'" class="h-full" />
          <SharingPanel v-else-if="activeApp === 'sharing'" class="h-full" />
          <AssistantPanel v-else-if="activeApp === 'assistant'" class="h-full" />
          <div v-else class="flex items-center justify-center h-full text-muted-foreground select-none">
            <div class="text-center space-y-3">
              <LayoutGridIcon class="size-12 mx-auto opacity-20" :stroke-width="1" />
              <p class="text-sm">{{ t('ui.views.DashboardLayout.selectAnAppFromThe') }}</p>
            </div>
          </div>
          </div>
          </Transition>
        </div>
      </template>
    </main>

    <!-- Mobile bottom nav -->
    <nav class="flex sm:hidden w-full flex-shrink-0 items-center h-14 overflow-hidden bg-sidebar border-t border-sidebar-border px-1 pb-[env(safe-area-inset-bottom)]">

      <!-- App nav (order mirrors the sidebar; not draggable on mobile) -->
      <div v-for="item in mobilePrimaryItems" :key="item.id" class="relative flex min-w-0 flex-1 justify-center">
        <span v-if="isActive(item.id)"
          class="absolute bottom-0 left-1/2 -translate-x-1/2 w-5 h-0.5 bg-primary rounded-t-full" />
        <Button variant="ghost" @click="selectApp(item.id)" :aria-label="item.label"
          :aria-current="isActive(item.id) ? 'page' : undefined"
          :class="['relative h-11 w-full max-w-11 rounded-xl transition-all duration-150 hover:bg-transparent [&_svg:not([class*=size-])]:size-5',
            isActive(item.id) ? 'text-primary' : 'text-muted-foreground']">
          <SidebarNavIcon :id="item.id" />
          <span v-if="item.id === 'settings' && updateAvailable && !isActive('settings')"
            class="absolute top-1.5 right-1.5 size-2 rounded-full bg-warning" />
          <span v-if="item.id === 'storage' && hasAlerts('storage.') && !isActive('storage')"
            class="absolute top-1.5 right-1.5 size-2 rounded-full bg-destructive" />
          <span v-if="item.id === 'monitor' && alerts.length && !isActive('monitor')"
            class="absolute top-1.5 right-1.5 size-2 rounded-full bg-destructive" />
        </Button>
      </div>

      <DropdownMenu v-if="mobileMoreItems.length">
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" :aria-label="t('ui.views.DashboardLayout.moreApps')"
            class="relative h-11 min-w-0 flex-1 rounded-xl text-muted-foreground hover:bg-transparent data-[state=open]:text-primary">
            <EllipsisIcon class="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="center" :side-offset="8" class="grid w-[calc(100vw-1.5rem)] grid-cols-2 gap-1 p-2">
          <DropdownMenuItem v-for="item in mobileMoreItems" :key="item.id" class="min-w-0 gap-3 px-3 py-3 [&_svg:not([class*=text-])]:text-current" @select="selectApp(item.id)">
            <SidebarNavIcon :id="item.id" class="shrink-0" />
            <span class="truncate">{{ item.label }}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- Notifications bell -->
      <ActivityPopover v-if="isMobile" side="top">
        <template #default="{ open }">
          <Button variant="ghost" :aria-label="t('ui.views.DashboardLayout.activity')"
            :class="['relative h-11 min-w-0 flex-1 rounded-xl transition-all duration-150 hover:bg-transparent',
              open ? 'text-primary' : 'text-muted-foreground']">
            <BellIcon class="size-5" />
            <span v-if="badgeCount > 0"
              class="absolute top-1.5 right-1.5 min-w-[14px] h-3.5 px-0.5 bg-primary rounded-full text-2xs font-bold text-primary-foreground flex items-center justify-center tabular-nums leading-none"
            >{{ badgeCount > 9 ? '9+' : badgeCount }}</span>
          </Button>
        </template>
      </ActivityPopover>

      <!-- User avatar -->
      <AccountMenu v-if="isMobile" side="top" @profile="goToProfile" @reset-order="resetSidebarOrder" @logout="handleLogout">
        <template #default="{ initials }">
          <Button variant="ghost" :aria-label="t('ui.views.DashboardLayout.account')"
            class="group h-11 min-w-0 flex-1 text-xs font-bold select-none hover:bg-transparent">
            <Avatar class="size-8 overflow-visible opacity-80 transition-all duration-150 group-data-[state=open]:opacity-100 group-data-[state=open]:ring-2 group-data-[state=open]:ring-primary group-data-[state=open]:ring-offset-2 group-data-[state=open]:ring-offset-sidebar">
              <AvatarFallback class="bg-primary font-bold text-primary-foreground">{{ initials }}</AvatarFallback>
            </Avatar>
          </Button>
        </template>
      </AccountMenu>

    </nav>

  </div>

  <!-- Nothing to report while the server is away (#132). -->
  <Toaster v-if="!maintenance.kind" position="top-right" close-button />
  <ConfirmDialog />
  <AgentRequests v-if="!maintenance.kind" />
  <PlanDialog />
  <JobLogsDialog v-if="isAdmin" />
  <Launchpad v-if="launchpadOpen" @close="launchpadOpen = false" />
  </div>
</template>
