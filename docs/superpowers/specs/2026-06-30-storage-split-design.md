# Storage Section Split — Design Spec

**Date:** 2026-06-30  
**Status:** Approved

## Context

`DisksSection.vue` is a 2191-line monolith handling physical disks, RAID arrays, and LVM volumes in three internal tabs. The goal is to split this into four independent nav sections, each focused on one layer of the Linux storage stack.

## Sections

| Section ID | Label | Component | Responsibility |
|---|---|---|---|
| `disks` | Disques | `PhysicalDisksSection.vue` | Physical disk cards, partitions, SMART |
| `raid` | RAID | `RaidSection.vue` | RAID array creation, destruction, status |
| `lvm` | LVM | `LvmSection.vue` | PV/VG/LV lifecycle |
| `mounts` | Montages | `MountsSection.vue` | Centralized mount/unmount/format view |

All four sections are admin-only, grouped under `group: 'admin'` in SettingsPanel nav.

## File Structure

```
apps/dashboard/src/
├── composables/
│   └── useStorageData.ts          ← NEW singleton composable
└── components/
    ├── storage/
    │   ├── PhysicalDisksSection.vue
    │   ├── RaidSection.vue
    │   ├── LvmSection.vue
    │   └── MountsSection.vue
    └── SettingsPanel.vue           ← updated nav + routing
```

`DisksSection.vue` is deleted once migration is complete.

## Shared Data — `useStorageData.ts`

Module-level singleton reactive state. First component to mount triggers the fetch; subsequent components share the same reactive refs.

```ts
const state = reactive({
  loading: false,
  error: '',
  devices: [] as BlockDev[],
  raids: [] as RaidArray[],
  lvmPVs: [] as LvmPV[],
  lvmVGs: [] as LvmVG[],
  lvmLVs: [] as LvmLV[],
  loaded: false,
})
let inflight: Promise<void> | null = null

async function fetchAll() { /* calls blockDevices + lvmInfo in parallel */ }

export function useStorageData() {
  function refresh() {
    if (!inflight) inflight = fetchAll()
    return inflight
  }
  onMounted(() => { if (!state.loaded) refresh() })
  return { ...toRefs(state), refresh }
}
```

After any mutation (format, mount, createRaid, etc.), the component calls `refresh()` to reload all data. The `inflight` guard prevents duplicate concurrent fetches.

## Cross-Section Navigation

Components emit a `navigate` event with the target section ID:

```ts
// in child component
const emit = defineEmits<{ navigate: [section: SectionId] }>()
// in template
<button @click="emit('navigate', 'raid')">Voir RAID →</button>
```

SettingsPanel wires it:
```html
<PhysicalDisksSection @navigate="focusOn" />
```

Use cases:
- Physical disk marked as RAID member → badge links to RAID section
- Physical disk used as LVM PV → badge links to LVM section
- RAID array used as LVM PV → badge in RaidSection links to LVM section

## SettingsPanel Changes

```ts
type SectionId = 'profile' | 'users' | 'places' | 'roles' | 'updates'
               | 'disks' | 'raid' | 'lvm' | 'mounts' | 'system' | 'audit'

// Nav entries (replacing single 'disks' entry):
{ id: 'disks',  label: 'Disques',  show: () => isAdmin.value, group: 'admin' },
{ id: 'raid',   label: 'RAID',     show: () => isAdmin.value, group: 'admin' },
{ id: 'lvm',    label: 'LVM',      show: () => isAdmin.value, group: 'admin' },
{ id: 'mounts', label: 'Montages', show: () => isAdmin.value, group: 'admin' },
```

`max-w-5xl` content width applied to: `users`, `roles`, `audit`, `disks`, `raid`, `lvm`, `mounts`.

## MountsSection — Centralized Mount View

Aggregates all mounted filesystems from three sources:

**Mounted table columns:** Mount point | Device | Source (badge) | FS type | Used / Total | Free | Actions

**Sources:**
- `devices` tree — partitions/disks with a mountpoint
- `raids` → matched BlockDev for usage info
- `lvmLVs` → via `lvToBlockDev()` for dm device info

**Actions:**
- Unmount → confirmation dialog with optional "remove from fstab"
- Source badge → `emit('navigate', ...)` to the owning section

**Second sub-section — Unformatted/Unmounted:**
Devices that have a filesystem but no mountpoint (from all sources), with a Mount button.

## Dialogs per Section

| Dialog | Sections |
|---|---|
| Format wizard | PhysicalDisksSection, RaidSection, LvmSection, MountsSection |
| Mount dialog | PhysicalDisksSection, RaidSection, LvmSection, MountsSection |
| Unmount dialog | MountsSection (primary), also PhysicalDisksSection/RaidSection/LvmSection |
| Partition dialogs (init/create/delete) | PhysicalDisksSection only |
| RAID create/destroy wizards | RaidSection only |
| LVM wizard, addLv, removeLv, removeVg dialogs | LvmSection only |

Format/Mount/Unmount dialogs are duplicated into each component that needs them (no shared dialog component — YAGNI, the template is self-contained).

## Shared Helpers

Extract shared pure functions into `composables/useStorageData.ts` alongside the data:
- `fmtBytes`, `usagePct`, `usageBarClass` — used everywhere
- `lvToBlockDev`, `lvToDmName` — needed by LvmSection and MountsSection
- `criticalMountPoints` — used by LvmSection and MountsSection

## Migration Order

1. Create `useStorageData.ts` composable
2. Create `PhysicalDisksSection.vue` (migrate disks tab + SMART)
3. Create `RaidSection.vue` (migrate raid tab)
4. Create `LvmSection.vue` (migrate lvm tab)
5. Create `MountsSection.vue` (new)
6. Update `SettingsPanel.vue` (new nav entries, new imports, routing)
7. Delete `DisksSection.vue`
8. TypeScript check + test
