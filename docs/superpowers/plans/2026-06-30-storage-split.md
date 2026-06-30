# Storage Section Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `DisksSection.vue` (2191-line monolith) into four focused sections — Physical Disks, RAID, LVM, and a new centralized Mounts view — backed by a shared `useStorageData` composable.

**Architecture:** A module-level singleton composable owns all reactive storage state and fetches it once; the four section components each import it and emit a `navigate` event for cross-section links; `SettingsPanel.vue` wires the four new nav entries and handles navigation.

**Tech Stack:** Vue 3 Composition API (`<script setup>`, `ref`, `reactive`, `computed`, `toRefs`, `onMounted`), tRPC vanilla proxy client, Tailwind CSS via CSS variables.

## Global Constraints

- No `@trpc/vue-query` or `useQuery` — use `await trpc.X.Y.query()` / `.mutate()` directly.
- Type-check command: `cd apps/dashboard && pnpm exec vue-tsc -b` — must pass with zero errors.
- All new components go in `apps/dashboard/src/components/storage/`.
- Composable goes in `apps/dashboard/src/composables/useStorageData.ts`.
- No new backend changes required — all tRPC procedures already exist.
- `DisksSection.vue` is deleted only in the final task, after all four new sections are wired up.

---

### Task 1: `useStorageData` composable

**Files:**
- Create: `apps/dashboard/src/composables/useStorageData.ts`

**Interfaces:**
- Produces: `useStorageData()` returning `{ loading, error, devices, raids, lvmPVs, lvmVGs, lvmLVs, loaded, refresh }` as refs + all exported types and helper functions listed below.

- [ ] **Step 1: Create the composable**

```ts
// apps/dashboard/src/composables/useStorageData.ts
import { reactive, toRefs, onMounted } from 'vue'
import { trpc } from '../lib/trpc'

// ── Types ─────────────────────────────────────────────────────────────────────

export type BlockDev = {
  name:        string
  path:        string
  size:        number
  type:        string
  fstype:      string
  mountpoint:  string
  model:       string
  uuid:        string
  isSystem:    boolean
  isRemovable: boolean
  usageTotal:  number
  usageUsed:   number
  usageFree:   number
  children:    BlockDev[]
}

export type RaidArray = {
  name:    string
  level:   string
  state:   string
  devices: string[]
  active:  number
  total:   number
}

export type LvmPV = { name: string; vgName: string; size: number; free: number }
export type LvmVG = { name: string; size: number; free: number; pvCount: number; lvCount: number }
export type LvmLV = { name: string; vgName: string; size: number; path: string }

// ── Shared helpers ─────────────────────────────────────────────────────────────

export const criticalMountPoints: Record<string, boolean> = {
  '/': true, '/boot': true, '/boot/efi': true, '/boot/grub': true,
  '/usr': true, '/var': true, '/home': true, '/etc': true,
}

export function fmtBytes(n: number): string {
  if (!n || n <= 0)   return '—'
  if (n < 1024)       return `${n} B`
  if (n < 1024 ** 2)  return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3)  return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n < 1024 ** 4)  return `${(n / 1024 ** 3).toFixed(2)} GB`
  return `${(n / 1024 ** 4).toFixed(2)} TB`
}

export function usagePct(dev: BlockDev | { total: number; used: number }): number {
  const total = 'usageTotal' in dev ? (dev as BlockDev).usageTotal : (dev as { total: number }).total
  const used  = 'usageUsed'  in dev ? (dev as BlockDev).usageUsed  : (dev as { used: number }).used
  return total > 0 ? Math.min(100, (used / total) * 100) : 0
}

export function usageBarClass(pct: number): string {
  if (pct >= 90) return 'bg-red-500'
  if (pct >= 75) return 'bg-yellow-500'
  return 'bg-[var(--c-accent)]'
}

export function fmtHours(h: number): string {
  if (h < 24) return `${h} h`
  if (h < 24 * 365) return `${Math.round(h / 24)} days`
  const y = Math.floor(h / (24 * 365))
  const d = Math.round((h % (24 * 365)) / 24)
  return `${y} yr ${d} d`
}

export function fmtTiB(v: number): string {
  if (v < 1) return `${(v * 1024).toFixed(0)} GiB`
  return `${v.toFixed(1)} TiB`
}

export function raidLevelLabel(level: string): string {
  const m: Record<string, string> = {
    raid0: 'RAID 0', raid1: 'RAID 1', raid5: 'RAID 5',
    raid6: 'RAID 6', raid10: 'RAID 10', linear: 'Linear',
  }
  return m[level] ?? level.toUpperCase()
}

export function raidDescription(level: string): string {
  const m: Record<string, string> = {
    raid0:  'Striping — no redundancy, max throughput',
    raid1:  'Mirroring — 1 drive fault tolerance',
    raid5:  'Parity striping — 1 drive fault tolerance',
    raid6:  'Double parity — 2 drive fault tolerance',
    raid10: 'Mirror + stripe — high performance & redundancy',
    linear: 'Linear concatenation',
  }
  return m[level] ?? ''
}

export function isRaidHealthy(r: RaidArray): boolean {
  return (r.state === 'active' || r.state === 'clean') && r.active === r.total
}

export function lvToDmName(lv: LvmLV): string {
  return lv.path
    .replace('/dev/', '')
    .split('/')
    .map((p: string) => p.replace(/-/g, '--'))
    .join('-')
}

export function lvToBlockDev(lv: LvmLV, devices: BlockDev[]): BlockDev {
  const dmName = lvToDmName(lv)
  const allDevs: BlockDev[] = []
  function walk(d: BlockDev) { allDevs.push(d); d.children?.forEach(walk) }
  devices.forEach(walk)
  const mountInfo = allDevs.find(d => d.name === dmName)
  const mp = mountInfo?.mountpoint ?? ''
  const isSystemLv = mountInfo?.isSystem === true || (mp !== '' && mp in criticalMountPoints)
  return {
    name:        dmName,
    path:        lv.path,
    size:        lv.size,
    type:        'lvm',
    fstype:      mountInfo?.fstype ?? '',
    mountpoint:  mp,
    model:       '',
    uuid:        mountInfo?.uuid ?? '',
    isSystem:    isSystemLv,
    isRemovable: false,
    usageTotal:  mountInfo?.usageTotal ?? 0,
    usageUsed:   mountInfo?.usageUsed ?? 0,
    usageFree:   mountInfo?.usageFree ?? 0,
    children:    [],
  }
}

// ── Singleton reactive state ───────────────────────────────────────────────────

const state = reactive({
  loading: false,
  error:   '',
  devices: [] as BlockDev[],
  raids:   [] as RaidArray[],
  lvmPVs:  [] as LvmPV[],
  lvmVGs:  [] as LvmVG[],
  lvmLVs:  [] as LvmLV[],
  loaded:  false,
})

let inflight: Promise<void> | null = null

async function fetchAll(): Promise<void> {
  state.loading = true
  state.error   = ''
  try {
    const [blk, lvm] = await Promise.all([
      trpc.system.blockDevices.query() as Promise<{ devices: BlockDev[]; raids: RaidArray[] }>,
      trpc.system.lvmInfo.query().catch(() => ({ pvs: [], vgs: [], lvs: [] })),
    ])
    state.devices = blk.devices ?? []
    state.raids   = blk.raids   ?? []
    state.lvmPVs  = lvm.pvs ?? []
    state.lvmVGs  = lvm.vgs ?? []
    state.lvmLVs  = lvm.lvs ?? []
    state.loaded  = true
  } catch (e: unknown) {
    state.error = (e as { message?: string })?.message ?? 'Failed to load storage info'
  } finally {
    state.loading = false
    inflight = null
  }
}

export function useStorageData() {
  function refresh(): Promise<void> {
    if (!inflight) inflight = fetchAll()
    return inflight
  }
  onMounted(() => { if (!state.loaded) refresh() })
  return { ...toRefs(state), refresh }
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
cd apps/dashboard && pnpm exec vue-tsc -b
```

Expected: zero errors (composable is not yet imported by anything, but its own types must be valid).

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/composables/useStorageData.ts
git commit -m "feat(storage): add useStorageData singleton composable with shared types and helpers"
```

---

### Task 2: `PhysicalDisksSection.vue`

**Files:**
- Create: `apps/dashboard/src/components/storage/PhysicalDisksSection.vue`
- Source to migrate from: `apps/dashboard/src/components/DisksSection.vue`

**Interfaces:**
- Consumes: `useStorageData()` from `../../composables/useStorageData`
- Produces: `defineEmits<{ navigate: [section: 'raid' | 'lvm'] }>()` — emitted when the user clicks a cross-section badge.

- [ ] **Step 1: Create the file with its script section**

Copy lines 1–98 of `DisksSection.vue` (SMART types + state + functions) and the shared dialog code, replacing the old local state with the composable. Key differences from the original:

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import { useStorageData, fmtBytes, fmtHours, fmtTiB, usagePct, usageBarClass, lvToDmName, criticalMountPoints, type BlockDev, type LvmPV, type RaidArray } from '../../composables/useStorageData'
import LoadingSpinner from '../ui/LoadingSpinner.vue'

const emit = defineEmits<{ navigate: [section: 'raid' | 'lvm'] }>()

const { loading, error, devices, raids, lvmPVs, refresh } = useStorageData()

// ── SMART (keep exactly as in DisksSection.vue lines 52–98) ───────────────────
// Copy: SmartAttr, NvmeInfo, SmartResult types
// Copy: smartCache, smartOpen refs
// Copy: toggleSmart(), fetchSmart(), smartStatus() functions

// ── Computed ──────────────────────────────────────────────────────────────────

const physicalDisks = computed(() => devices.value.filter(d => d.type === 'disk'))

// Helper: is this disk a member of any RAID array?
function diskRaidName(diskName: string): string | undefined {
  return raids.value.find(r =>
    r.devices.some(d => d === diskName || diskName.startsWith(d))
  )?.name
}

// Helper: is this disk (or any of its partitions) used as an LVM PV?
function diskPvVg(diskName: string): string | undefined {
  return lvmPVs.value.find(p => {
    const pvDev = p.name.replace('/dev/', '')
    // exact match OR strip trailing partition suffix (sda1→sda, nvme0n1p1→nvme0n1)
    return pvDev === diskName || pvDev.replace(/p?\d+$/, '') === diskName
  })?.vgName
}

// ── UI state ──────────────────────────────────────────────────────────────────

const openMenu    = ref<string | null>(null)
const dangerDisks = ref(new Set<string>())

function toggleDanger(name: string) {
  const s = new Set(dangerDisks.value)
  if (s.has(name)) s.delete(name)
  else s.add(name)
  dangerDisks.value = s
}

// ── Partition dialogs (copy from DisksSection.vue lines 352–409) ──────────────
// Copy: partInitDlg, partCreateDlg, partDeleteDlg refs
// Copy: doPartInit(), doPartCreate(), doPartDelete(), partNumOf() functions

// ── Format / Mount / Unmount (copy from DisksSection.vue lines 512–614) ───────
// Copy: FsType, FS_OPTIONS
// Copy: formatWiz, mountDlg, umountDlg refs
// Copy: openFormat(), doFormat(), openMount(), doMount(), openUmount(), doUmount()
// In doFormat/doMount/doUmount, replace `await load()` with `await refresh()`
</script>
```

- [ ] **Step 2: Add the template**

The template has two parts:

**Part A — Section shell + disk cards** (copy from DisksSection.vue lines 1069–1372, removing the `v-if="activeTab === 'disks'"` wrapper and the outer `<template v-if="!loading && !error">` guard since this component is always the disks view):

Key additions within each disk card header (after the SYSTEM/USB badges, before the SMART button):

```html
<!-- Cross-nav: RAID membership badge -->
<button v-if="diskRaidName(disk.name)" @click="emit('navigate', 'raid')"
  class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors">
  RAID {{ diskRaidName(disk.name) }} →
</button>
<!-- Cross-nav: LVM PV badge -->
<button v-if="diskPvVg(disk.name)" @click="emit('navigate', 'lvm')"
  class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20 transition-colors">
  LVM {{ diskPvVg(disk.name) }} →
</button>
```

**Part B — Dialogs** (copy from DisksSection.vue):
- Format wizard: lines 1379–1506
- Mount dialog: lines 1509–1558
- Unmount dialog: copy from after Mount dialog (~lines 1559–1610)
- Partition init/create/delete dialogs: copy from after Unmount dialog

Wrap the whole template:
```html
<template>
  <div>
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Disques physiques</h2>
        <p class="text-sm text-[var(--c-text-3)] mt-0.5">Disques, partitions et état S.M.A.R.T.</p>
      </div>
      <button @click="refresh" :disabled="loading" title="Refresh" class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
        <svg :class="['w-4 h-4', loading && 'animate-spin']" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
      </button>
    </div>

    <div v-if="loading && !devices.length" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm mt-6">
      <LoadingSpinner /> Loading…
    </div>
    <div v-else-if="error" class="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-400">{{ error }}</div>

    <div v-if="openMenu" class="fixed inset-0 z-20" @click="openMenu = null"/>

    <template v-if="!loading || devices.length">
      <!-- disk cards (from DisksSection.vue lines 1074–1372) -->
      <!-- format/mount/unmount/partition dialogs (Teleport blocks) -->
    </template>
  </div>
</template>
```

- [ ] **Step 3: Type-check**

```bash
cd apps/dashboard && pnpm exec vue-tsc -b
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/storage/PhysicalDisksSection.vue
git commit -m "feat(storage): add PhysicalDisksSection with SMART, partitions, cross-nav emit"
```

---

### Task 3: `RaidSection.vue`

**Files:**
- Create: `apps/dashboard/src/components/storage/RaidSection.vue`

**Interfaces:**
- Consumes: `useStorageData()` — needs `raids`, `devices`, `lvmPVs`, `refresh`
- Produces: `defineEmits<{ navigate: [section: 'lvm'] }>()`

- [ ] **Step 1: Create the script section**

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import { useStorageData, fmtBytes, usagePct, usageBarClass, raidLevelLabel, raidDescription, isRaidHealthy, type BlockDev, type RaidArray } from '../../composables/useStorageData'

const emit = defineEmits<{ navigate: [section: 'lvm'] }>()

const { loading, error, devices, raids, lvmPVs, lvmVGs, refresh } = useStorageData()

// ── Computed ──────────────────────────────────────────────────────────────────

const raidBlockDevs = computed(() =>
  devices.value.filter(d => d.type === 'md' || raids.value.find(r => r.name === d.name))
)

function raidBlockDev(name: string): BlockDev | undefined {
  return raidBlockDevs.value.find(d => d.name === name)
}

// Is this RAID array used as an LVM PV?
function raidPvVg(raidName: string): string | undefined {
  return lvmPVs.value.find(p => p.name === `/dev/${raidName}`)?.vgName
}

// Eligible for RAID (copy from DisksSection.vue lines 157–173, using composable refs)
// Copy: makeRaidChecker(), eligibleForRaid computed

// ── RAID wizard (copy from DisksSection.vue lines 618–700) ───────────────────
// Copy: RAID_LEVELS, nextMdName(), raidWiz ref, openRaidWizard(), selectedRaidLevel,
//       toggleRaidDev(), raidCanAdvance, doCreateRaid()
// Replace `await load()` with `await refresh()`

// ── Destroy RAID (copy from DisksSection.vue lines 703–731) ──────────────────
// Copy: destroyDlg ref, openDestroy(), doDestroyRaid()
// Replace `await load()` with `await refresh()`

// ── Format / Mount / Unmount (same as PhysicalDisksSection) ──────────────────
// Copy: FsType, FS_OPTIONS, formatWiz, mountDlg, umountDlg, openFormat/Mount/Umount,
//       doFormat/Mount/Umount — replacing `await load()` with `await refresh()`

const openMenu = ref<string | null>(null)
</script>
```

- [ ] **Step 2: Add the template**

Header + "Create RAID" button, then the RAID arrays list. Copy from DisksSection.vue lines 789–931 (the `<section v-if="activeTab === 'raid'">` block), removing the `v-if="activeTab === 'raid'"` wrapper.

Add cross-nav badge in each RAID card header after the health badge:

```html
<!-- Cross-nav: RAID used as LVM PV -->
<button v-if="raidPvVg(r.name)" @click="emit('navigate', 'lvm')"
  class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20 transition-colors">
  LVM {{ raidPvVg(r.name) }} →
</button>
```

Then append the RAID create wizard dialog and destroy dialog (Teleport blocks from DisksSection.vue), plus the format/mount/unmount dialogs.

Full template shell:
```html
<template>
  <div>
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">RAID</h2>
        <p class="text-sm text-[var(--c-text-3)] mt-0.5">Gérer les arrays RAID logiciels (mdadm).</p>
      </div>
      <div class="flex items-center gap-2">
        <button @click="openRaidWizard" class="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
          Create RAID
        </button>
        <button @click="refresh" :disabled="loading" title="Refresh" class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
          <svg :class="['w-4 h-4', loading && 'animate-spin']" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
        </button>
      </div>
    </div>

    <div v-if="loading && !raids.length" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm mt-6"><LoadingSpinner /> Loading…</div>
    <div v-else-if="error" class="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-400">{{ error }}</div>

    <div v-if="openMenu" class="fixed inset-0 z-20" @click="openMenu = null"/>

    <!-- RAID arrays list (from DisksSection.vue lines 803–931) -->
    <!-- RAID create wizard dialog (Teleport) -->
    <!-- Destroy dialog (Teleport) -->
    <!-- Format/Mount/Unmount dialogs (Teleport) -->
  </div>
</template>
```

- [ ] **Step 3: Type-check**

```bash
cd apps/dashboard && pnpm exec vue-tsc -b
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/storage/RaidSection.vue
git commit -m "feat(storage): add RaidSection with wizard, destroy, and cross-nav to LVM"
```

---

### Task 4: `LvmSection.vue`

**Files:**
- Create: `apps/dashboard/src/components/storage/LvmSection.vue`

**Interfaces:**
- Consumes: `useStorageData()` — needs `devices`, `raids`, `lvmPVs`, `lvmVGs`, `lvmLVs`, `refresh`
- Produces: no `navigate` emit (LVM is a leaf — nothing links deeper from LVM)

- [ ] **Step 1: Create the script section**

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import { useStorageData, fmtBytes, usagePct, usageBarClass, lvToBlockDev, criticalMountPoints, type BlockDev, type LvmVG, type LvmLV } from '../../composables/useStorageData'

const { loading, error, devices, raids, lvmPVs, lvmVGs, lvmLVs, refresh } = useStorageData()

// ── Computed ──────────────────────────────────────────────────────────────────

// Eligible for LVM (copy from DisksSection.vue lines 176–201, using composable refs)
// Copy: makeRaidChecker(), allDevices(), eligibleForLvm computed

function vgFreePct(vg: LvmVG): number {
  return vg.size > 0 ? Math.min(100, (vg.free / vg.size) * 100) : 0
}

function isSystemVg(vgName: string): boolean {
  return lvmLVs.value
    .filter(l => l.vgName === vgName)
    .some(l => {
      const bd = lvToBlockDev(l, devices.value)
      return bd.isSystem || Object.keys(criticalMountPoints).some(mp => bd.mountpoint === mp)
    })
}

// Wrapper so template can call without passing devices each time
function lv2bd(lv: LvmLV): BlockDev {
  return lvToBlockDev(lv, devices.value)
}

// ── LVM wizard (copy from DisksSection.vue lines 248–349) ────────────────────
// Copy: lvmWiz, openLvmWizard(), toggleLvmDev(), doCreateLvm()
// Copy: addLvDlg, doAddLv()
// Copy: removeLvDlg, doRemoveLv()
// Copy: removeVgDlg, doRemoveVg()
// Replace all `await load()` with `await refresh()`
// Replace all `lvToBlockDev(lv)` calls with `lv2bd(lv)`

// ── Format / Mount / Unmount ──────────────────────────────────────────────────
// Copy: FsType, FS_OPTIONS, formatWiz, mountDlg, umountDlg,
//       openFormat/Mount/Umount, doFormat/Mount/Umount
// Replace `await load()` with `await refresh()`

const openMenu = ref<string | null>(null)
</script>
```

- [ ] **Step 2: Add the template**

Copy from DisksSection.vue lines 937–1066 (the `<section v-if="activeTab === 'lvm'">` block), removing the `v-if="activeTab === 'lvm'"` wrapper. Replace all `lvToBlockDev(lv)` calls in the template with `lv2bd(lv)`.

Template shell:
```html
<template>
  <div>
    <div class="flex items-start justify-between mb-4">
      <div>
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">LVM</h2>
        <p class="text-sm text-[var(--c-text-3)] mt-0.5">Physical volumes, volume groups, and logical volumes.</p>
      </div>
      <div class="flex items-center gap-2">
        <button @click="openLvmWizard" class="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-[var(--c-border)] text-[var(--c-text-2)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
          Create VG
        </button>
        <button @click="refresh" :disabled="loading" title="Refresh" class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
          <svg :class="['w-4 h-4', loading && 'animate-spin']" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
        </button>
      </div>
    </div>

    <div v-if="loading && !lvmVGs.length" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm mt-6"><LoadingSpinner /> Loading…</div>
    <div v-else-if="error" class="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-400">{{ error }}</div>

    <div v-if="openMenu" class="fixed inset-0 z-20" @click="openMenu = null"/>

    <!-- VG list (from DisksSection.vue lines 951–1066) -->
    <!-- LVM wizard dialog (Teleport) -->
    <!-- Add LV dialog (Teleport) -->
    <!-- Remove LV dialog (Teleport) -->
    <!-- Remove VG dialog (Teleport) -->
    <!-- Format/Mount/Unmount dialogs (Teleport) -->
  </div>
</template>
```

- [ ] **Step 3: Type-check**

```bash
cd apps/dashboard && pnpm exec vue-tsc -b
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/storage/LvmSection.vue
git commit -m "feat(storage): add LvmSection migrated from DisksSection LVM tab"
```

---

### Task 5: `MountsSection.vue`

**Files:**
- Create: `apps/dashboard/src/components/storage/MountsSection.vue`

**Interfaces:**
- Consumes: `useStorageData()` — needs `devices`, `raids`, `lvmPVs`, `lvmVGs`, `lvmLVs`, `refresh`
- Produces: `defineEmits<{ navigate: [section: 'disks' | 'raid' | 'lvm'] }>()`

- [ ] **Step 1: Create the script section**

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import { useStorageData, fmtBytes, usagePct, usageBarClass, lvToBlockDev, raidLevelLabel, isRaidHealthy, type BlockDev } from '../../composables/useStorageData'

const emit = defineEmits<{ navigate: [section: 'disks' | 'raid' | 'lvm'] }>()

const { loading, error, devices, raids, lvmPVs, lvmVGs, lvmLVs, refresh } = useStorageData()

// ── Aggregated mount data ─────────────────────────────────────────────────────

type MountSource = 'disk' | 'raid' | 'lvm'

type MountEntry = {
  key:        string
  device:     string      // /dev/sdb1
  mountpoint: string
  fstype:     string
  source:     MountSource
  sourceLabel: string     // "RAID 1" | "LVM vg0/lv0" | "sdb"
  usageTotal: number
  usageUsed:  number
  usageFree:  number
  bd:         BlockDev
}

type UnmountedEntry = {
  key:         string
  device:      string
  fstype:      string
  source:      MountSource
  sourceLabel: string
  size:        number
  bd:          BlockDev
}

function allBlockDevFlat(): BlockDev[] {
  const out: BlockDev[] = []
  function walk(d: BlockDev) { out.push(d); d.children?.forEach(walk) }
  devices.value.forEach(walk)
  return out
}

const mounted = computed<MountEntry[]>(() => {
  const entries: MountEntry[] = []
  const raidNames = new Set(raids.value.map(r => r.name))
  const pvDevs    = new Set(lvmPVs.value.map(p => p.name.replace('/dev/', '')))

  // Physical disk partitions/raw disks that are mounted
  for (const bd of allBlockDevFlat()) {
    if (!bd.mountpoint) continue
    if (raidNames.has(bd.name)) continue              // RAID md device handled separately
    if (bd.type === 'dm' || bd.type === 'lvm') continue  // LVM DM handled via lvmLVs
    if (bd.fstype === 'swap') continue                // skip swap
    const parentDisk = devices.value.find(d => bd.name.startsWith(d.name) && d.type === 'disk')
    entries.push({
      key:         `disk:${bd.name}`,
      device:      `/dev/${bd.name}`,
      mountpoint:  bd.mountpoint,
      fstype:      bd.fstype,
      source:      'disk',
      sourceLabel: parentDisk?.name ?? bd.name,
      usageTotal:  bd.usageTotal,
      usageUsed:   bd.usageUsed,
      usageFree:   bd.usageFree,
      bd,
    })
  }

  // RAID arrays that are mounted
  for (const r of raids.value) {
    const bd = allBlockDevFlat().find(d => d.name === r.name)
    if (!bd?.mountpoint) continue
    entries.push({
      key:         `raid:${r.name}`,
      device:      `/dev/${r.name}`,
      mountpoint:  bd.mountpoint,
      fstype:      bd.fstype,
      source:      'raid',
      sourceLabel: raidLevelLabel(r.level),
      usageTotal:  bd.usageTotal,
      usageUsed:   bd.usageUsed,
      usageFree:   bd.usageFree,
      bd,
    })
  }

  // LVM logical volumes that are mounted
  for (const lv of lvmLVs.value) {
    const bd = lvToBlockDev(lv, devices.value)
    if (!bd.mountpoint) continue
    entries.push({
      key:         `lvm:${lv.path}`,
      device:      lv.path,
      mountpoint:  bd.mountpoint,
      fstype:      bd.fstype,
      source:      'lvm',
      sourceLabel: `${lv.vgName}/${lv.name}`,
      usageTotal:  bd.usageTotal,
      usageUsed:   bd.usageUsed,
      usageFree:   bd.usageFree,
      bd,
    })
  }

  return entries.sort((a, b) => a.mountpoint.localeCompare(b.mountpoint))
})

const unmounted = computed<UnmountedEntry[]>(() => {
  const entries: UnmountedEntry[] = []
  const raidNames = new Set(raids.value.map(r => r.name))

  for (const bd of allBlockDevFlat()) {
    if (bd.mountpoint || !bd.fstype) continue
    if (raidNames.has(bd.name)) continue
    if (bd.type === 'dm' || bd.type === 'lvm' || bd.isSystem) continue
    if (bd.fstype === 'swap') continue
    const parentDisk = devices.value.find(d => bd.name.startsWith(d.name) && d.type === 'disk')
    entries.push({
      key:         `disk:${bd.name}`,
      device:      `/dev/${bd.name}`,
      fstype:      bd.fstype,
      source:      'disk',
      sourceLabel: parentDisk?.name ?? bd.name,
      size:        bd.size,
      bd,
    })
  }

  for (const r of raids.value) {
    const bd = allBlockDevFlat().find(d => d.name === r.name)
    if (!bd || bd.mountpoint || !bd.fstype) continue
    entries.push({
      key:         `raid:${r.name}`,
      device:      `/dev/${r.name}`,
      fstype:      bd.fstype,
      source:      'raid',
      sourceLabel: raidLevelLabel(r.level),
      size:        bd.size,
      bd,
    })
  }

  for (const lv of lvmLVs.value) {
    const bd = lvToBlockDev(lv, devices.value)
    if (bd.mountpoint || !bd.fstype || bd.isSystem) continue
    entries.push({
      key:         `lvm:${lv.path}`,
      device:      lv.path,
      fstype:      bd.fstype,
      source:      'lvm',
      sourceLabel: `${lv.vgName}/${lv.name}`,
      size:        lv.size,
      bd,
    })
  }

  return entries
})

const sourceNavTarget: Record<MountSource, 'disks' | 'raid' | 'lvm'> = {
  disk: 'disks',
  raid: 'raid',
  lvm:  'lvm',
}

const sourceBadgeClass: Record<MountSource, string> = {
  disk:  'bg-[var(--c-surface-deep)] text-[var(--c-text-3)] border-[var(--c-border)] hover:border-[var(--c-border-strong)]',
  raid:  'bg-blue-500/10 text-blue-400 border-blue-500/20 hover:bg-blue-500/20',
  lvm:   'bg-purple-500/10 text-purple-400 border-purple-500/20 hover:bg-purple-500/20',
}

// ── Format / Mount / Unmount ──────────────────────────────────────────────────
// Copy: FsType, FS_OPTIONS, formatWiz, mountDlg, umountDlg,
//       openFormat/Mount/Umount, doFormat/Mount/Umount from DisksSection.vue
// Replace `await load()` with `await refresh()`
</script>
```

- [ ] **Step 2: Add the template**

```html
<template>
  <div>
    <div class="flex items-start justify-between mb-6">
      <div>
        <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Montages</h2>
        <p class="text-sm text-[var(--c-text-3)] mt-0.5">Tous les systèmes de fichiers montés, toutes sources.</p>
      </div>
      <button @click="refresh" :disabled="loading" title="Refresh" class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors">
        <svg :class="['w-4 h-4', loading && 'animate-spin']" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
      </button>
    </div>

    <div v-if="loading && !mounted.length && !unmounted.length" class="flex items-center gap-2 text-[var(--c-text-3)] text-sm mt-6"><LoadingSpinner /> Loading…</div>
    <div v-else-if="error" class="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-400">{{ error }}</div>

    <template v-else>
      <!-- Mounted filesystems -->
      <div v-if="mounted.length === 0" class="rounded-xl border border-dashed border-[var(--c-border)] bg-[var(--c-surface)] px-4 py-6 text-center text-sm text-[var(--c-text-3)] mb-6">
        No filesystems currently mounted.
      </div>
      <div v-else class="rounded-xl border border-[var(--c-border)] overflow-hidden mb-8">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="bg-[var(--c-surface-deep)] border-b border-[var(--c-border)] text-[var(--c-text-3)] text-xs uppercase tracking-wide">
              <th class="text-left px-4 py-3 font-medium">Point de montage</th>
              <th class="text-left px-4 py-3 font-medium">Device</th>
              <th class="text-left px-4 py-3 font-medium w-28">Source</th>
              <th class="text-left px-4 py-3 font-medium w-16">FS</th>
              <th class="text-left px-4 py-3 font-medium w-44">Utilisé / Total</th>
              <th class="text-right px-4 py-3 font-medium w-24">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--c-border)]">
            <tr v-for="e in mounted" :key="e.key" class="hover:bg-[var(--c-hover)]/30 transition-colors">
              <td class="px-4 py-2.5 font-mono text-xs text-[var(--c-text-1)]">{{ e.mountpoint }}</td>
              <td class="px-4 py-2.5 font-mono text-xs text-[var(--c-text-3)] truncate max-w-0 w-40">{{ e.device }}</td>
              <td class="px-4 py-2.5">
                <button @click="emit('navigate', sourceNavTarget[e.source])"
                  :class="['inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border transition-colors', sourceBadgeClass[e.source]]">
                  {{ e.sourceLabel }} →
                </button>
              </td>
              <td class="px-4 py-2.5 font-mono text-[10px] text-[var(--c-text-3)] uppercase">{{ e.fstype }}</td>
              <td class="px-4 py-2.5">
                <div v-if="e.usageTotal > 0">
                  <div class="flex justify-between text-[10px] text-[var(--c-text-3)] mb-1">
                    <span>{{ fmtBytes(e.usageUsed) }}</span>
                    <span>{{ fmtBytes(e.usageTotal) }}</span>
                  </div>
                  <div class="h-1 bg-[var(--c-surface-deep)] rounded-full overflow-hidden">
                    <div class="h-full rounded-full" :class="usageBarClass(usagePct(e.bd))" :style="{ width: usagePct(e.bd) + '%' }"/>
                  </div>
                  <div class="text-[10px] text-[var(--c-text-3)] mt-0.5">{{ fmtBytes(e.usageFree) }} libre</div>
                </div>
                <span v-else class="text-[10px] text-[var(--c-text-3)] italic">—</span>
              </td>
              <td class="px-4 py-2.5 text-right">
                <button v-if="!e.bd.isSystem" @click="openUmount(e.bd)"
                  class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-orange-500/50 hover:text-orange-400 transition-colors">
                  Unmount
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Unmounted with filesystem -->
      <template v-if="unmounted.length > 0">
        <h3 class="text-sm font-medium text-[var(--c-text-2)] mb-3">Non montés</h3>
        <div class="rounded-xl border border-[var(--c-border)] overflow-hidden">
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="bg-[var(--c-surface-deep)] border-b border-[var(--c-border)] text-[var(--c-text-3)] text-xs uppercase tracking-wide">
                <th class="text-left px-4 py-3 font-medium">Device</th>
                <th class="text-left px-4 py-3 font-medium w-28">Source</th>
                <th class="text-left px-4 py-3 font-medium w-16">FS</th>
                <th class="text-left px-4 py-3 font-medium w-24">Taille</th>
                <th class="text-right px-4 py-3 font-medium w-32">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[var(--c-border)]">
              <tr v-for="e in unmounted" :key="e.key" class="hover:bg-[var(--c-hover)]/30 transition-colors">
                <td class="px-4 py-2.5 font-mono text-xs text-[var(--c-text-2)]">{{ e.device }}</td>
                <td class="px-4 py-2.5">
                  <button @click="emit('navigate', sourceNavTarget[e.source])"
                    :class="['inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border transition-colors', sourceBadgeClass[e.source]]">
                    {{ e.sourceLabel }} →
                  </button>
                </td>
                <td class="px-4 py-2.5 font-mono text-[10px] text-[var(--c-text-3)] uppercase">{{ e.fstype }}</td>
                <td class="px-4 py-2.5 text-xs text-[var(--c-text-3)] tabular-nums">{{ fmtBytes(e.size) }}</td>
                <td class="px-4 py-2.5 text-right flex items-center justify-end gap-1.5">
                  <button @click="openFormat(e.bd)"
                    class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-[var(--c-accent)]/50 hover:text-[var(--c-accent)] transition-colors">
                    Format
                  </button>
                  <button @click="openMount(e.bd)"
                    class="text-[11px] px-2 py-0.5 rounded border border-[var(--c-border)] text-[var(--c-text-3)] hover:border-green-500/50 hover:text-green-400 transition-colors">
                    Mount
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>

    <!-- Format / Mount / Unmount dialogs (Teleport blocks, same as other sections) -->
  </div>
</template>
```

- [ ] **Step 3: Import LoadingSpinner**

Add `import LoadingSpinner from '../ui/LoadingSpinner.vue'` to the script section.

- [ ] **Step 4: Type-check**

```bash
cd apps/dashboard && pnpm exec vue-tsc -b
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/storage/MountsSection.vue
git commit -m "feat(storage): add MountsSection — centralized mount/unmount/format view"
```

---

### Task 6: Update `SettingsPanel.vue`

**Files:**
- Modify: `apps/dashboard/src/components/SettingsPanel.vue`

**Interfaces:**
- Consumes the four new section components' `navigate` emit
- Wires `focusOn` as the handler: `<PhysicalDisksSection @navigate="focusOn" />`

- [ ] **Step 1: Replace imports**

Replace:
```ts
import DisksSection from './DisksSection.vue'
```
With:
```ts
import PhysicalDisksSection from './storage/PhysicalDisksSection.vue'
import RaidSection           from './storage/RaidSection.vue'
import LvmSection            from './storage/LvmSection.vue'
import MountsSection         from './storage/MountsSection.vue'
```

- [ ] **Step 2: Update `SectionId`**

```ts
type SectionId = 'profile' | 'users' | 'places' | 'roles' | 'updates'
               | 'disks' | 'raid' | 'lvm' | 'mounts' | 'system' | 'audit'
```

- [ ] **Step 3: Replace the `disks` nav entry with four entries**

Replace:
```ts
{ id: 'disks',  label: 'Disks',  show: () => isAdmin.value, group: 'admin' },
```
With:
```ts
{ id: 'disks',  label: 'Disques',  show: () => isAdmin.value, group: 'admin' },
{ id: 'raid',   label: 'RAID',     show: () => isAdmin.value, group: 'admin' },
{ id: 'lvm',    label: 'LVM',      show: () => isAdmin.value, group: 'admin' },
{ id: 'mounts', label: 'Montages', show: () => isAdmin.value, group: 'admin' },
```

- [ ] **Step 4: Add icons for the three new nav items**

In the nav icon `v-else-if` chain, after the disks icon block, add:

```html
<!-- RAID icon -->
<svg v-else-if="item.id === 'raid'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
  <path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10"/>
</svg>
<!-- LVM icon -->
<svg v-else-if="item.id === 'lvm'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
  <path stroke-linecap="round" stroke-linejoin="round" d="M3 7h18M3 12h18M3 17h18"/>
</svg>
<!-- Mounts icon -->
<svg v-else-if="item.id === 'mounts'" class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
  <path stroke-linecap="round" stroke-linejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"/>
</svg>
```

- [ ] **Step 5: Update content routing and `max-w-5xl` condition**

Replace:
```html
<div :class="['p-8', active === 'users' || active === 'roles' || active === 'audit' ? 'max-w-5xl' : 'max-w-2xl']">
  ...
  <DisksSection v-else-if="active === 'disks'" />
  ...
</div>
```
With:
```html
<div :class="['p-8', ['users','roles','audit','disks','raid','lvm','mounts'].includes(active) ? 'max-w-5xl' : 'max-w-2xl']">
  ...
  <PhysicalDisksSection v-else-if="active === 'disks'"  @navigate="focusOn" />
  <RaidSection          v-else-if="active === 'raid'"   @navigate="focusOn" />
  <LvmSection           v-else-if="active === 'lvm'" />
  <MountsSection        v-else-if="active === 'mounts'" @navigate="focusOn" />
  ...
</div>
```

- [ ] **Step 6: Type-check**

```bash
cd apps/dashboard && pnpm exec vue-tsc -b
```

Expected: zero errors. Fix any TypeScript errors before continuing.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/components/SettingsPanel.vue
git commit -m "feat(storage): wire four storage sections in SettingsPanel with cross-nav"
```

---

### Task 7: Delete `DisksSection.vue` and final typecheck

**Files:**
- Delete: `apps/dashboard/src/components/DisksSection.vue`

- [ ] **Step 1: Delete the old file**

```bash
rm apps/dashboard/src/components/DisksSection.vue
```

- [ ] **Step 2: Confirm nothing imports it**

```bash
grep -r "DisksSection" apps/dashboard/src/
```

Expected: no output (zero remaining imports).

- [ ] **Step 3: Final type-check**

```bash
cd apps/dashboard && pnpm exec vue-tsc -b
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "refactor(storage): remove DisksSection.vue — replaced by four focused sections"
```
