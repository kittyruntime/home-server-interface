# Design: Storage & Monitor as Dedicated Apps

**Date:** 2026-07-01  
**Status:** Approved

## Problem

`SettingsPanel.vue` mixes two distinct concerns: system *configuration* (profile, users, roles, permissions, places, updates) and active *management/monitoring* (storage hardware, system metrics, audit log). These feel different to use — one is set-and-forget, the other you open regularly to observe.

## Solution

Introduce two new desktop apps so each window has a focused purpose:

| App | Sections | Icon concept |
|---|---|---|
| **Storage** | Disks, RAID, LVM, Mounts | disk stack |
| **Monitor** | Overview, System, Audit Log | activity chart |
| **Settings** (trimmed) | Profile, Users, Roles, Permissions, Places, Updates | gear |

Settings becomes pure configuration. Storage and Monitor are operational tools.

## Architecture

### `desktop.ts`
- `AppId` union: add `'storage' | 'monitor'`  
- `APP_LABEL`, `APP_ICON_PATH`, `DEFAULT_SIZE`: add entries for both  
- No new `focusSection` types needed (no cross-app nav from desktop layer)

### `StoragePanel.vue` (new — `components/storage/`)
- Same two-column sidebar/content layout as SettingsPanel  
- `SectionId = 'disks' | 'raid' | 'lvm' | 'mounts'`  
- Icons and nav items lifted from SettingsPanel  
- Cross-navigation (`@navigate="focusOn"`) preserved within the panel  
- Default active: `'disks'`

### `MonitorPanel.vue` (new — `components/monitor/`)
- Same layout  
- `SectionId = 'overview' | 'system' | 'audit'`  
- Default active: `'overview'` (dashboard is the natural landing)

### `SettingsPanel.vue` (trimmed)
- Remove: Overview, Disks, RAID, LVM, Mounts, System, Audit Log  
- Remove their imports and nav entries  
- `SectionId` simplified to: `'profile' | 'users' | 'places' | 'permissions' | 'roles' | 'updates'`  
- `max-w-5xl` condition simplified (only `users`, `roles`, `permissions` remain wide)

### `DesktopWindow.vue`
- Import and render `StoragePanel` for `appId === 'storage'`  
- Import and render `MonitorPanel` for `appId === 'monitor'`

### `Launchpad.vue`
- Import `useAuth`, compute visible app list  
- `storage` and `monitor` shown only when `isAdmin`

## Constraints
- Vue 3 `<script setup>` + TypeScript strict  
- `cd apps/dashboard && pnpm exec vue-tsc -b` → 0 errors  
- All UI text in English  
- Tailwind v4 with `var(--c-*)` tokens  

## Out of scope
- No new tRPC endpoints  
- No new backend changes  
- No routing or URL changes  
- No cross-app `focusSection` deep-linking (can be added later)
