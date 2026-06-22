# Role-binding UI redesign + default-role cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the row-based "+/✕" Add/Remove UI for role↔user assignment with a polished chip-list + search-dropdown picker, lightly polish the permission checkbox list's visual hierarchy, and stop seeding two unused empty default roles — per the spec at `docs/superpowers/specs/2026-06-22-role-binding-redesign-design.md`.

**Architecture:** A new, purely presentational `RolePicker.vue` component (chips for already-assigned items + a "+ Add" button that opens an anchored popover with search) replaces the role-list markup inside `UserDetailPanel.vue` and the member-list markup inside `RoleEditor.vue`. Both call sites keep their existing tRPC calls and busy-state tracking — the component only emits `add`/`remove` events with an id. No backend or schema changes.

**Tech Stack:** Vue 3 + TS (Composition API, `<script setup>`), Tailwind utility classes matching this codebase's existing `--c-*` design tokens, Prisma/SQLite seed script. No test framework in this repo — verification is `vue-tsc -b` / `vite build` + a manual pass against the running dev servers.

## Global Constraints

- `RolePicker.vue` is purely presentational: no tRPC calls, no busy-state bookkeeping inside it — that stays in the consuming component (`UserDetailPanel.vue`/`RoleEditor.vue`), exactly as today.
- Every existing business rule must be preserved unchanged: a user cannot remove their own role/membership (`isSelf` / `currentUserId` checks), the "admin" sublabel on admin roles, per-id busy-state disabling during in-flight requests.
- No change to any tRPC router or mutation (`role.assignUser`/`removeUser`, `role.addPermission`/`removePermission`) — only the calling UI changes.
- No schema/migration changes. The `readonly`/`readwrite` seed removal only stops *creating* those rows going forward; it must not delete or touch any existing database row.
- Verification gate for every frontend task: `cd apps/dashboard && pnpm exec vue-tsc -b && pnpm exec vite build`.

---

## Task 1: `RolePicker.vue` component

**Files:**
- Create: `apps/dashboard/src/components/ui/RolePicker.vue`

**Interfaces:**
- Produces: `export type PickerItem = { id: string; label: string; sublabel?: string; disabled?: boolean; avatarText?: string; avatarClass?: string }`, and the default-exported component with:
  - Props: `assigned: PickerItem[]`, `available: PickerItem[]`, `busy?: Record<string, boolean>`
  - Emits: `add: [id: string]`, `remove: [id: string]`

- [ ] **Step 1: Create the component**

Create `apps/dashboard/src/components/ui/RolePicker.vue`:

```vue
<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

export type PickerItem = {
  id: string
  label: string
  sublabel?: string
  disabled?: boolean
  avatarText?: string
  avatarClass?: string
}

const props = defineProps<{
  assigned: PickerItem[]
  available: PickerItem[]
  busy?: Record<string, boolean>
}>()
const emit = defineEmits<{ add: [id: string]; remove: [id: string] }>()

const open = ref(false)
const search = ref('')
const rootRef = ref<HTMLDivElement | null>(null)

const filteredAvailable = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.available
  return props.available.filter(i =>
    i.label.toLowerCase().includes(q) || (i.sublabel ?? '').toLowerCase().includes(q),
  )
})

function isBusy(id: string) {
  return props.busy?.[id] ?? false
}

function openPicker() {
  open.value = true
  search.value = ''
}
function closePicker() {
  open.value = false
}
function togglePicker() {
  if (open.value) closePicker()
  else openPicker()
}

function pick(id: string) {
  emit('add', id)
  closePicker()
}

function onDocMousedown(e: MouseEvent) {
  if (!open.value) return
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) closePicker()
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) closePicker()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMousedown)
  document.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocMousedown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="rootRef" class="relative space-y-2">
    <div v-if="assigned.length > 0" class="space-y-0.5">
      <div
        v-for="item in assigned"
        :key="item.id"
        class="group flex items-center gap-2.5 px-3 py-1.5 rounded-lg hover:bg-[var(--c-hover)] transition-colors"
      >
        <span
          v-if="item.avatarText"
          :class="['w-6 h-6 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-[10px] font-bold shrink-0', item.avatarClass]"
        >{{ item.avatarText }}</span>
        <span v-else class="w-1.5 h-1.5 rounded-full bg-[var(--c-accent)] shrink-0" />

        <span class="flex-1 min-w-0 flex items-baseline gap-2">
          <span class="text-sm font-medium text-[var(--c-text-1)] truncate">{{ item.label }}</span>
          <span v-if="item.sublabel" class="text-[10px] text-[var(--c-text-3)] uppercase tracking-wide shrink-0">{{ item.sublabel }}</span>
        </span>

        <button
          :disabled="item.disabled || isBusy(item.id)"
          @click="emit('remove', item.id)"
          :title="item.disabled ? 'Cannot remove' : 'Remove'"
          :class="[
            'p-1 rounded transition-all shrink-0',
            item.disabled
              ? 'opacity-30 cursor-not-allowed text-[var(--c-text-3)]'
              : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-[var(--c-text-3)] hover:text-[var(--c-accent)] hover:bg-[var(--c-accent-subtle)] disabled:opacity-30 disabled:cursor-not-allowed',
          ]"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>
    <p v-else class="text-xs text-[var(--c-text-3)] italic px-3">None assigned.</p>

    <button
      v-if="available.length > 0"
      @click="togglePicker"
      class="flex items-center gap-1 text-xs text-[var(--c-accent)] hover:opacity-80 transition-colors px-3"
    >
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
      </svg>
      Add
    </button>

    <div
      v-if="open"
      class="absolute z-20 left-0 top-full mt-1 w-64 bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl shadow-lg overflow-hidden"
    >
      <div class="p-2 border-b border-[var(--c-border)]">
        <div class="relative">
          <svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--c-text-3)] pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"/>
          </svg>
          <input v-model="search" autofocus placeholder="Search…" class="ui-input pl-8"/>
        </div>
      </div>
      <div class="max-h-48 overflow-y-auto py-1">
        <button
          v-for="item in filteredAvailable"
          :key="item.id"
          @click="pick(item.id)"
          class="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--c-hover)] transition-colors"
        >
          <span
            v-if="item.avatarText"
            :class="['w-5 h-5 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-[9px] font-bold shrink-0', item.avatarClass]"
          >{{ item.avatarText }}</span>
          <span class="text-sm text-[var(--c-text-2)] truncate flex-1">{{ item.label }}</span>
          <span v-if="item.sublabel" class="text-[10px] text-[var(--c-text-3)] uppercase tracking-wide shrink-0">{{ item.sublabel }}</span>
        </button>
        <p v-if="filteredAvailable.length === 0" class="px-3 py-2 text-xs text-[var(--c-text-3)] italic">No matches</p>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/ui/RolePicker.vue
git commit -m "feat(dashboard): add RolePicker chip+dropdown component"
```

---

## Task 2: Integrate `RolePicker` into `UserDetailPanel.vue`

**Files:**
- Modify: `apps/dashboard/src/components/UserDetailPanel.vue`

**Interfaces:**
- Consumes: `RolePicker` (`assigned`, `available`, `busy` props; `add`/`remove` emits) and `PickerItem` type from Task 1, both from `./ui/RolePicker.vue`.

- [ ] **Step 1: Add the import and computed lists**

In `apps/dashboard/src/components/UserDetailPanel.vue`, change the script imports (currently `import { ref, reactive, computed } from 'vue'`) to also import `RolePicker`:

```ts
import { ref, reactive, computed } from 'vue'
import { trpc } from '../lib/trpc'
import { useAuth } from '../lib/auth'
import RolePicker, { type PickerItem } from './ui/RolePicker.vue'
```

Immediately after the existing `function userIsAdmin()` function (after line 51), add:

```ts
const assignedRoles = computed<PickerItem[]>(() =>
  props.roles
    .filter(r => hasRole(r.id))
    .map(r => ({ id: r.id, label: r.name, sublabel: r.isAdmin ? 'admin' : undefined, disabled: isSelf.value })),
)
const availableRoles = computed<PickerItem[]>(() =>
  props.roles
    .filter(r => !hasRole(r.id))
    .map(r => ({ id: r.id, label: r.name, sublabel: r.isAdmin ? 'admin' : undefined })),
)
```

- [ ] **Step 2: Replace the Roles section markup**

Replace the entire "── Role assignment ──" block (the `<div v-if="roles.length > 0" class="space-y-3">...</div>` currently spanning lines 178–232) with:

```vue
    <!-- ── Role assignment ─────────────────────────────────────────────────── -->
    <div v-if="roles.length > 0" class="space-y-3">
      <h4 class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Roles</h4>

      <RolePicker
        :assigned="assignedRoles"
        :available="availableRoles"
        :busy="roleToggleBusy"
        @add="toggleRole"
        @remove="toggleRole"
      />

      <p v-if="roleError" class="text-[var(--c-accent)] text-xs px-3">{{ roleError }}</p>
    </div>
```

- [ ] **Step 3: Typecheck and build**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b && pnpm exec vite build`
Expected: no errors.

- [ ] **Step 4: Manual check (needs running backend)**

With the dev servers running, log in as an admin, go to Settings → Users → open a non-self user's detail panel. Confirm: assigned roles show as a compact list with an "admin" tag where applicable; hovering a row reveals a remove icon; clicking "+ Add" opens a popover with a search box and the remaining roles; typing filters the list; clicking a result adds the role and the popover closes; the role moves from the popover list into the assigned list above. Open your own user's detail panel and confirm none of your own roles show a (clickable) remove icon.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/UserDetailPanel.vue
git commit -m "feat(dashboard): use RolePicker for user role assignment"
```

---

## Task 3: Integrate `RolePicker` into `RoleEditor.vue` Members section

**Files:**
- Modify: `apps/dashboard/src/components/RoleEditor.vue`

**Interfaces:**
- Consumes: `RolePicker`/`PickerItem` from Task 1.

- [ ] **Step 1: Add the import and avatar/computed helpers**

Change the script imports (currently `import { ref, computed } from 'vue'`) to:

```ts
import { ref, computed } from 'vue'
import { trpc } from '../lib/trpc'
import { useAuth } from '../lib/auth'
import RolePicker, { type PickerItem } from './ui/RolePicker.vue'
```

Immediately after the existing `function userHasRole(user: User)` function, add:

```ts
const palette = [
  'from-blue-500 to-blue-700', 'from-violet-500 to-violet-700',
  'from-emerald-500 to-emerald-700', 'from-amber-500 to-amber-700',
  'from-rose-500 to-rose-700', 'from-cyan-500 to-cyan-700',
]
function avatarGradient(username: string) {
  let hash = 0
  for (const ch of username) hash = (hash * 31 + ch.charCodeAt(0)) % palette.length
  return palette[hash]
}

const assignedMembers = computed<PickerItem[]>(() =>
  sortedUsers.value
    .filter(u => userHasRole(u))
    .map(u => ({
      id: u.id,
      label: u.username,
      sublabel: u.id === currentUserId.value ? 'you' : undefined,
      disabled: u.id === currentUserId.value,
      avatarText: u.username.slice(0, 2).toUpperCase(),
      avatarClass: avatarGradient(u.username),
    })),
)
const availableMembers = computed<PickerItem[]>(() =>
  sortedUsers.value
    .filter(u => !userHasRole(u))
    .map(u => ({
      id: u.id,
      label: u.username,
      avatarText: u.username.slice(0, 2).toUpperCase(),
      avatarClass: avatarGradient(u.username),
    })),
)
```

- [ ] **Step 2: Replace the Members section markup**

Replace the entire "── Members ──" block (the `<div class="space-y-3">...</div>` currently spanning lines 296–365) with:

```vue
    <!-- ── Members ─────────────────────────────────────────────────────────── -->
    <div class="space-y-3">
      <div class="flex items-center justify-between px-0.5">
        <h4 class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Members</h4>
        <span class="text-xs text-[var(--c-text-3)]">{{ sortedUsers.filter(u => userHasRole(u)).length }} / {{ users.length }}</span>
      </div>

      <p v-if="users.length === 0" class="text-xs text-[var(--c-text-3)] italic px-0.5">No users</p>

      <RolePicker
        v-else
        :assigned="assignedMembers"
        :available="availableMembers"
        :busy="memberBusy"
        @add="toggleMember"
        @remove="toggleMember"
      />
    </div>
```

- [ ] **Step 3: Typecheck and build**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b && pnpm exec vite build`
Expected: no errors.

- [ ] **Step 4: Manual check (needs running backend)**

Settings → Roles → open a non-admin role. Confirm: assigned members show avatar-initial circles with the same gradient colors used elsewhere in the app (Users table), "+ Add" opens the search popover listing the remaining users, search filters by username, picking one moves it into the assigned list. Open the "admin" role and confirm your own account's row shows no clickable remove icon.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/RoleEditor.vue
git commit -m "feat(dashboard): use RolePicker for role member assignment"
```

---

## Task 4: Permission list visual polish (`RoleEditor.vue`)

**Files:**
- Modify: `apps/dashboard/src/components/RoleEditor.vue`

- [ ] **Step 1: Widen the gap between groups**

Find the permission-groups wrapper:

```vue
    <div class="space-y-5">
      <h4 class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Permissions</h4>
```

Change `space-y-5` to `space-y-6` so each permission group reads as a more clearly separated section:

```vue
    <div class="space-y-6">
      <h4 class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Permissions</h4>
```

- [ ] **Step 2: Rebalance each permission row's name/description hierarchy**

This is two separate, non-adjacent text replacements inside the same `v-for="perm in group.permissions"` row (the checkbox `<span>` block between them stays exactly as-is — do not touch it).

**Replacement A** — the row's opening tag. Find:

```vue
        <div
          v-for="perm in group.permissions"
          :key="perm.name"
          @click="togglePermission(perm.name)"
          :class="[
            'flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer select-none transition-colors',
            grantedNames.has(perm.name)
              ? 'bg-[var(--c-success)]/8 hover:bg-[var(--c-success)]/12'
              : 'hover:bg-[var(--c-hover)]',
          ]"
        >
```

Replace with (only the first class, `gap-3` → `gap-3.5`, changes):

```vue
        <div
          v-for="perm in group.permissions"
          :key="perm.name"
          @click="togglePermission(perm.name)"
          :class="[
            'flex items-center gap-3.5 px-3 py-2 rounded-lg cursor-pointer select-none transition-colors',
            grantedNames.has(perm.name)
              ? 'bg-[var(--c-success)]/8 hover:bg-[var(--c-success)]/12'
              : 'hover:bg-[var(--c-hover)]',
          ]"
        >
```

**Replacement B** — the name/description block further down the same row. Find:

```vue
          <!-- Permission name + description -->
          <div class="flex-1 min-w-0 flex items-baseline gap-2.5">
            <code class="text-xs font-mono text-[var(--c-text-2)] shrink-0">{{ perm.name }}</code>
            <span class="text-xs text-[var(--c-text-3)] truncate">{{ perm.desc }}</span>
          </div>
        </div>
```

Replace with:

```vue
          <!-- Permission name + description -->
          <div class="flex-1 min-w-0 flex items-baseline justify-between gap-3">
            <code class="text-xs font-mono text-[var(--c-text-2)] shrink-0">{{ perm.name }}</code>
            <span class="text-[11px] text-[var(--c-text-3)]/80 truncate text-right">{{ perm.desc }}</span>
          </div>
        </div>
```

- [ ] **Step 3: Typecheck and build**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b && pnpm exec vite build`
Expected: no errors.

- [ ] **Step 4: Manual check**

Open Settings → Roles → any role. Confirm permission groups (Users/Places/Files/Containers/System) have clearer separation, and each row shows the permission name on the left and its description in smaller, right-aligned, muted text — checkbox toggling still works by clicking anywhere on the row.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/RoleEditor.vue
git commit -m "fix(dashboard): polish permission list visual hierarchy in RoleEditor"
```

---

## Task 5: Remove `readonly`/`readwrite` default roles from the seed script

**Files:**
- Modify: `packages/database/prisma/seed.ts`

- [ ] **Step 1: Remove the loop**

In `packages/database/prisma/seed.ts`, delete these lines (currently lines 35–38):

```ts
  // Standard roles
  for (const name of ["readonly", "readwrite"]) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } })
  }

```

So the function goes directly from the `userRole.upsert` block to the `// Well-known permissions` comment, with one blank line between them (matching the existing spacing convention between sections in this file).

- [ ] **Step 2: Verify the file still runs**

Run: `cd packages/database && npx prisma db seed`
Expected: exits 0, prints `Seeded admin user, roles, and well-known permissions`, and does NOT create new `readonly`/`readwrite` rows (any pre-existing ones from before this change are untouched — `upsert` was never `delete`, so removing the loop only stops future creation).

- [ ] **Step 3: Commit**

```bash
git add packages/database/prisma/seed.ts
git commit -m "fix(database): stop seeding unused readonly/readwrite default roles"
```

---

## Task 6: Full verification pass

**Files:**
- None to modify — this is a verification-only task confirming the whole change end-to-end.

- [ ] **Step 1: Full frontend build**

Run: `cd apps/dashboard && pnpm exec vue-tsc -b && pnpm exec vite build`
Expected: no errors.

- [ ] **Step 2: Manual pass (needs a running backend)**

With backend + dashboard dev servers running, log in as admin:
1. Settings → Users → open any user with at least one role: confirm the new `RolePicker` shows assigned roles as a clean list, "+ Add" opens a working search popover, adding/removing works and persists after reload.
2. Settings → Roles → open any role with members: confirm the same picker behavior for users, with gradient avatar initials matching the Users table's avatar style.
3. In the same role, confirm the permission list (Users/Places/Files/Containers/System groups) still toggles correctly on click and reads with clearer name/description hierarchy.
4. Confirm a brand-new role (no members yet) shows "None assigned." and no orphaned UI artifacts; confirm a role where every user is already a member hides the "+ Add" button entirely.
5. Confirm typing in the search popover that matches nothing shows "No matches", and pressing Escape or clicking outside the popover closes it without adding anything.

- [ ] **Step 3: No commit needed for this task** (verification only).
