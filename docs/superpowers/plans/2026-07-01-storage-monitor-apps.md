# Storage & Monitor Apps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Storage (Disks/RAID/LVM/Mounts) and Monitor (Overview/System/Audit Log) from SettingsPanel into two dedicated desktop apps.

**Architecture:** Introduce two new `AppId` values (`'storage'` and `'monitor'`), create one panel component per app following the same two-column sidebar/content pattern as `SettingsPanel.vue`, remove those sections from Settings, wire the panels into `DesktopWindow.vue`, and make the Launchpad show admin-only apps conditionally.

**Tech Stack:** Vue 3 `<script setup>` + TypeScript, Tailwind v4, `var(--c-*)` tokens.

## Global Constraints

- Vue 3 `<script setup>` + TypeScript strict — no `any`, no `@ts-ignore`
- `cd apps/dashboard && pnpm exec vue-tsc -b` → 0 errors after every task
- Tailwind v4 with `var(--c-*)` CSS tokens — no hardcoded colours
- All UI text in English
- Commit style: `refactor(scope): description`
- No new tRPC endpoints, no backend changes

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `apps/dashboard/src/lib/desktop.ts` | Add `'storage'` and `'monitor'` to `AppId`; add labels, icons, sizes |
| Create | `apps/dashboard/src/components/storage/StoragePanel.vue` | Sidebar + content shell for Disks/RAID/LVM/Mounts |
| Create | `apps/dashboard/src/components/monitor/MonitorPanel.vue` | Sidebar + content shell for Overview/System/Audit Log |
| Modify | `apps/dashboard/src/components/SettingsPanel.vue` | Remove extracted sections |
| Modify | `apps/dashboard/src/components/desktop/DesktopWindow.vue` | Render StoragePanel and MonitorPanel |
| Modify | `apps/dashboard/src/components/desktop/Launchpad.vue` | Show admin-only apps |

---

## Task 1 — Extend `desktop.ts` with new AppIds

**Files:**
- Modify: `apps/dashboard/src/lib/desktop.ts`

**Interfaces:**
- Produces: `AppId` now includes `'storage' | 'monitor'`; `APP_LABEL`, `APP_ICON_PATH`, `DEFAULT_SIZE`, `MULTI_INSTANCE` all updated

- [ ] **Step 1: Update `AppId`, `APP_LABEL`, and `APP_ICON_PATH`**

In `apps/dashboard/src/lib/desktop.ts`, change the top section:

```ts
export type AppId = 'files' | 'apps' | 'settings' | 'storage' | 'monitor' | 'file-preview'
export type SettingsSection = 'profile' | 'users' | 'places' | 'roles' | 'updates'

export const APP_LABEL: Record<AppId, string> = {
  files: 'Files',
  apps: 'Apps',
  settings: 'Settings',
  storage: 'Storage',
  monitor: 'Monitor',
  'file-preview': 'Preview',
}

export const APP_ICON_PATH: Record<AppId, string> = {
  files: 'M3 7a2 2 0 012-2h3.586a1 1 0 01.707.293L11 7h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  apps: 'M5 12H19M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01',
  settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
  storage: 'M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-13.5 0v-1.5m13.5 1.5v-1.5m0-10.5a3 3 0 00-3-3H9.75a3 3 0 00-3 3m9.75 0a3 3 0 01-3 3h-3a3 3 0 01-3-3m9.75 0H4.5m15 0h.008v.008H19.5v-.008z',
  monitor: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  'file-preview': 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
}
```

- [ ] **Step 2: Update `DEFAULT_SIZE`**

```ts
const DEFAULT_SIZE: Record<AppId, { w: number; h: number }> = {
  files: { w: 860, h: 560 },
  apps: { w: 760, h: 540 },
  settings: { w: 860, h: 560 },
  storage: { w: 900, h: 580 },
  monitor: { w: 860, h: 580 },
  'file-preview': { w: 760, h: 560 },
}
```

- [ ] **Step 3: Type-check**

```bash
cd apps/dashboard && pnpm exec vue-tsc -b
```

Expected: errors about `APP_ICON_PATH` missing keys (storage/monitor) — fixed by Step 1. After both steps: 0 errors.

---

## Task 2 — Create `StoragePanel.vue`

**Files:**
- Create: `apps/dashboard/src/components/storage/StoragePanel.vue`

**Interfaces:**
- Consumes: `PhysicalDisksSection`, `RaidSection`, `LvmSection`, `MountsSection` (existing)
- Produces: standalone panel component, no props, no emits

- [ ] **Step 1: Create the file**

Create `apps/dashboard/src/components/storage/StoragePanel.vue`:

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import PhysicalDisksSection from './PhysicalDisksSection.vue'
import RaidSection from './RaidSection.vue'
import LvmSection from './LvmSection.vue'
import MountsSection from './MountsSection.vue'

type SectionId = 'disks' | 'raid' | 'lvm' | 'mounts'

interface NavItem { id: SectionId; label: string }

const nav: NavItem[] = [
  { id: 'disks',  label: 'Disks' },
  { id: 'raid',   label: 'RAID' },
  { id: 'lvm',    label: 'LVM' },
  { id: 'mounts', label: 'Mounts' },
]

const active = ref<SectionId>('disks')

function focusOn(section: SectionId) {
  active.value = section
}
</script>

<template>
  <div class="flex flex-col sm:flex-row h-full">

    <!-- Mobile picker -->
    <div class="sm:hidden flex-shrink-0 border-b border-[var(--c-border)] bg-[var(--c-sidebar)] px-4 py-2.5">
      <select v-model="active" class="w-full bg-transparent text-sm text-[var(--c-text-2)] focus:outline-none">
        <option v-for="item in nav" :key="item.id" :value="item.id">{{ item.label }}</option>
      </select>
    </div>

    <!-- Left nav -->
    <nav class="hidden sm:flex w-48 flex-shrink-0 border-r border-[var(--c-border)] bg-[var(--c-sidebar)] py-5 px-2 flex-col gap-0.5 overflow-y-auto">
      <div v-for="item in nav" :key="item.id" class="relative flex items-center">
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
          <!-- Disks -->
          <svg v-if="item.id === 'disks'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-13.5 0v-1.5m13.5 1.5v-1.5m0-10.5a3 3 0 00-3-3H9.75a3 3 0 00-3 3m9.75 0a3 3 0 01-3 3h-3a3 3 0 01-3-3m9.75 0H4.5m15 0h.008v.008H19.5v-.008z"/>
          </svg>
          <!-- RAID -->
          <svg v-else-if="item.id === 'raid'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10"/>
          </svg>
          <!-- LVM -->
          <svg v-else-if="item.id === 'lvm'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 7h18M3 12h18M3 17h18"/>
          </svg>
          <!-- Mounts -->
          <svg v-else-if="item.id === 'mounts'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"/>
          </svg>
          {{ item.label }}
        </button>
      </div>
    </nav>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto">
      <div class="p-8 max-w-5xl">
        <PhysicalDisksSection v-if="active === 'disks'"  @navigate="focusOn" />
        <RaidSection          v-else-if="active === 'raid'"   @navigate="focusOn" />
        <LvmSection           v-else-if="active === 'lvm'" />
        <MountsSection        v-else-if="active === 'mounts'" @navigate="focusOn" />
      </div>
    </div>

  </div>
</template>
```

- [ ] **Step 2: Type-check**

```bash
cd apps/dashboard && pnpm exec vue-tsc -b
```

Expected: 0 errors.

---

## Task 3 — Create `MonitorPanel.vue`

**Files:**
- Create: `apps/dashboard/src/components/monitor/MonitorPanel.vue`

**Interfaces:**
- Consumes: `OverviewSection`, `SystemSection`, `AuditLogSection` (existing)
- Produces: standalone panel component, no props, no emits

- [ ] **Step 1: Create the directory and file**

```bash
mkdir -p apps/dashboard/src/components/monitor
```

Create `apps/dashboard/src/components/monitor/MonitorPanel.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import OverviewSection from '../OverviewSection.vue'
import SystemSection from '../SystemSection.vue'
import AuditLogSection from '../AuditLogSection.vue'

type SectionId = 'overview' | 'system' | 'audit'

interface NavItem { id: SectionId; label: string }

const nav: NavItem[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'system',   label: 'System' },
  { id: 'audit',    label: 'Audit Log' },
]

const active = ref<SectionId>('overview')
</script>

<template>
  <div class="flex flex-col sm:flex-row h-full">

    <!-- Mobile picker -->
    <div class="sm:hidden flex-shrink-0 border-b border-[var(--c-border)] bg-[var(--c-sidebar)] px-4 py-2.5">
      <select v-model="active" class="w-full bg-transparent text-sm text-[var(--c-text-2)] focus:outline-none">
        <option v-for="item in nav" :key="item.id" :value="item.id">{{ item.label }}</option>
      </select>
    </div>

    <!-- Left nav -->
    <nav class="hidden sm:flex w-48 flex-shrink-0 border-r border-[var(--c-border)] bg-[var(--c-sidebar)] py-5 px-2 flex-col gap-0.5 overflow-y-auto">
      <div v-for="item in nav" :key="item.id" class="relative flex items-center">
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
          <!-- Overview -->
          <svg v-if="item.id === 'overview'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"/>
          </svg>
          <!-- System -->
          <svg v-else-if="item.id === 'system'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
          </svg>
          <!-- Audit -->
          <svg v-else-if="item.id === 'audit'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/>
          </svg>
          {{ item.label }}
        </button>
      </div>
    </nav>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto">
      <div :class="['p-8', active === 'audit' ? 'max-w-5xl' : 'max-w-4xl']">
        <OverviewSection  v-if="active === 'overview'" />
        <SystemSection    v-else-if="active === 'system'" />
        <AuditLogSection  v-else-if="active === 'audit'" />
      </div>
    </div>

  </div>
</template>
```

- [ ] **Step 2: Type-check**

```bash
cd apps/dashboard && pnpm exec vue-tsc -b
```

Expected: 0 errors.

---

## Task 4 — Trim `SettingsPanel.vue`

**Files:**
- Modify: `apps/dashboard/src/components/SettingsPanel.vue`

**Interfaces:**
- Produces: `SectionId = 'profile' | 'users' | 'places' | 'permissions' | 'roles' | 'updates'`; `focusSection` prop narrowed to same type

- [ ] **Step 1: Replace the entire `<script setup>` block**

Replace the script block of `apps/dashboard/src/components/SettingsPanel.vue` with:

```vue
<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAuth } from '../lib/auth'
import ProfileSection from './ProfileSection.vue'
import UserListPanel from './UserListPanel.vue'
import PlacesSection from './PlacesSection.vue'
import RolesSection from './RolesSection.vue'
import UpdateSection from './UpdateSection.vue'
import PermissionsSection from './PermissionsSection.vue'

const { isAdmin, canManageUsers } = useAuth()

type SectionId = 'profile' | 'users' | 'places' | 'permissions' | 'roles' | 'updates'

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
  { id: 'permissions', label: 'Permissions', show: () => isAdmin.value, group: 'admin' },
  { id: 'roles',       label: 'Roles',       show: () => isAdmin.value, group: 'admin' },
  { id: 'updates',     label: 'Updates',     show: () => isAdmin.value, group: 'admin' },
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
```

- [ ] **Step 2: Update the template content area**

Replace the content area `<div class="flex-1 overflow-y-auto">` block in the template:

```html
    <!-- ── Content area ───────────────────────────────────────────────── -->
    <div class="flex-1 overflow-y-auto">
      <div :class="['p-8', ['users','roles','permissions'].includes(active) ? 'max-w-5xl' : 'max-w-2xl']">

        <ProfileSection     v-if="active === 'profile'" />
        <UserListPanel      v-else-if="active === 'users'" />
        <PlacesSection      v-else-if="active === 'places'" />
        <PermissionsSection v-else-if="active === 'permissions'" />
        <RolesSection       v-else-if="active === 'roles'" />
        <UpdateSection      v-else-if="active === 'updates'" />

      </div>
    </div>
```

- [ ] **Step 3: Update the nav SVG icons block**

The nav icon block in the template currently has icons for all 13 sections. Replace it with icons only for the remaining 6 sections. The left nav section in the template should have these icon conditions (inside the `<button>` element, replacing all `<svg v-if / v-else-if>` blocks):

```html
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
            <!-- Permissions icon -->
            <svg v-else-if="item.id === 'permissions'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/>
            </svg>
            <!-- Roles icon -->
            <svg v-else-if="item.id === 'roles'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
            </svg>
            <!-- Updates icon -->
            <svg v-else-if="item.id === 'updates'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
            </svg>
```

- [ ] **Step 4: Type-check**

```bash
cd apps/dashboard && pnpm exec vue-tsc -b
```

Expected: 0 errors.

---

## Task 5 — Wire panels into `DesktopWindow.vue`

**Files:**
- Modify: `apps/dashboard/src/components/desktop/DesktopWindow.vue`

**Interfaces:**
- Consumes: `StoragePanel` from `../storage/StoragePanel.vue`, `MonitorPanel` from `../monitor/MonitorPanel.vue`

- [ ] **Step 1: Add imports**

At the top of the `<script setup>` block in `DesktopWindow.vue`, after the existing imports:

```ts
import StoragePanel from '../storage/StoragePanel.vue'
import MonitorPanel from '../monitor/MonitorPanel.vue'
```

- [ ] **Step 2: Add panel rendering in the template**

In the content area (`<div class="flex-1 overflow-hidden">`), after the existing `<SettingsPanel>` line:

```html
      <StoragePanel v-else-if="win.appId === 'storage'" class="h-full" />
      <MonitorPanel v-else-if="win.appId === 'monitor'" class="h-full" />
```

The full content block becomes:

```html
    <div class="flex-1 overflow-hidden">
      <FileBrowserPanel v-if="win.appId === 'files'" class="h-full" :desktopWindow="true" />
      <AppsPanel v-else-if="win.appId === 'apps'" ref="appsPanelRef" class="h-full" />
      <SettingsPanel v-else-if="win.appId === 'settings'" ref="settingsPanelRef" class="h-full" :focusSection="win.focusSection ?? null" />
      <StoragePanel v-else-if="win.appId === 'storage'" class="h-full" />
      <MonitorPanel v-else-if="win.appId === 'monitor'" class="h-full" />
      <FilePreviewBody v-else-if="win.appId === 'file-preview'" ref="filePreviewRef" :entry="win.filePreview!" class="h-full" @dirty="setDirty(win.id, $event)" />
    </div>
```

- [ ] **Step 3: Type-check**

```bash
cd apps/dashboard && pnpm exec vue-tsc -b
```

Expected: 0 errors.

---

## Task 6 — Update Launchpad to show admin-only apps

**Files:**
- Modify: `apps/dashboard/src/components/desktop/Launchpad.vue`

**Interfaces:**
- Consumes: `useAuth` from `../../lib/auth`

- [ ] **Step 1: Update the Launchpad script**

Replace the entire `<script setup>` block in `Launchpad.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useDesktop, APP_LABEL, APP_ICON_PATH, type AppId } from '../../lib/desktop'
import { useAuth } from '../../lib/auth'

const emit = defineEmits<{ close: [] }>()
const { openApp } = useDesktop()
const { isAdmin } = useAuth()

const allApps: { id: AppId; adminOnly: boolean }[] = [
  { id: 'files',   adminOnly: false },
  { id: 'apps',    adminOnly: false },
  { id: 'storage', adminOnly: true },
  { id: 'monitor', adminOnly: true },
  { id: 'settings', adminOnly: false },
]

const visibleApps = computed(() =>
  allApps.filter(a => !a.adminOnly || isAdmin.value).map(a => a.id)
)

function launch(id: AppId) {
  openApp(id)
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>
```

- [ ] **Step 2: Update the template to use `visibleApps`**

Replace the template in `Launchpad.vue`:

```html
<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 bg-[var(--c-bg)] flex items-center justify-center"
      @click.self="emit('close')"
    >
      <div class="grid grid-cols-4 gap-8 p-8">
        <button
          v-for="id in visibleApps"
          :key="id"
          @click="launch(id)"
          class="flex flex-col items-center gap-3 p-4 rounded-2xl hover:bg-[var(--c-hover)] transition-colors"
        >
          <div class="w-16 h-16 rounded-2xl bg-[var(--c-surface)] border border-[var(--c-border-strong)] flex items-center justify-center text-[var(--c-text-2)]">
            <svg class="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" :d="APP_ICON_PATH[id]"/>
            </svg>
          </div>
          <span class="eyebrow">{{ APP_LABEL[id] }}</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>
```

- [ ] **Step 3: Type-check**

```bash
cd apps/dashboard && pnpm exec vue-tsc -b
```

Expected: 0 errors.

- [ ] **Step 4: Final commit**

```bash
git add \
  apps/dashboard/src/lib/desktop.ts \
  apps/dashboard/src/components/storage/StoragePanel.vue \
  apps/dashboard/src/components/monitor/MonitorPanel.vue \
  apps/dashboard/src/components/SettingsPanel.vue \
  apps/dashboard/src/components/desktop/DesktopWindow.vue \
  apps/dashboard/src/components/desktop/Launchpad.vue
git commit -m "refactor(ui): split Storage and Monitor into dedicated desktop apps"
```

---

## Verification Checklist

- [ ] Launchpad shows Storage + Monitor icons only when logged in as admin
- [ ] Opening Storage → defaults to Disks tab; RAID cross-nav to LVM works; Mounts cross-nav to Disks works
- [ ] Opening Monitor → defaults to Overview tab; System and Audit Log tabs work
- [ ] Settings no longer contains any storage or monitoring sections
- [ ] `pnpm exec vue-tsc -b` → 0 errors
- [ ] Existing localStorage window state from old Settings still loads (old `focusSection` values for removed sections just get ignored — the `watch` in SettingsPanel only acts if the value is a valid `SectionId`)
