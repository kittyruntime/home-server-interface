# Role-binding UI redesign + default-role cleanup

## Context

The role↔user assignment UI (`RoleEditor.vue`'s "Members" section, `UserDetailPanel.vue`'s
"Roles" section) currently renders each candidate as a full-width row with a pill/chip-style
"+ Add" or "✕ Remove" button. The user describes this as looking like "tags with a plus on
them" — functional but not polished. Separately, the seed script creates two permission-less
default roles ("readonly"/"readwrite") that do nothing and clutter the Roles list.

This spec covers three independent, additive changes — no backend mutation changes, no schema
changes.

## Scope

- **In scope**: a new reusable chip+dropdown picker component for role↔user assignment;
  replacing the row-based Add/Remove UI in `RoleEditor.vue` and `UserDetailPanel.vue` with it;
  a visual-only polish pass on `RoleEditor.vue`'s permission checkbox list; removing the
  `readonly`/`readwrite` default roles from the seed script.
- **Out of scope**: the Places permission matrix (`PlacesSection.vue`) — table/checkbox pattern
  stays as-is; any backend/tRPC API changes (`role.assignUser`/`removeUser`,
  `role.addPermission`/`removePermission` are reused unchanged); cleaning up `readonly`/
  `readwrite` roles on already-provisioned installations (left for manual deletion via the
  existing "Delete role" button); restructuring the permission list into a grid/table.

## Component: `RolePicker.vue`

New file: `apps/dashboard/src/components/ui/RolePicker.vue`.

Purely presentational — owns no tRPC calls, no busy-state bookkeeping (that stays in the
consuming components, matching today's pattern where `RoleEditor.vue`/`UserDetailPanel.vue`
track `memberBusy`/`roleToggleBusy` per id).

**Props:**
```ts
type PickerItem = {
  id: string
  label: string
  sublabel?: string   // e.g. a user's displayName, or an "admin" tag for roles
  disabled?: boolean  // e.g. can't remove your own role from yourself
}
defineProps<{
  assigned: PickerItem[]    // currently-assigned items, in display order
  available: PickerItem[]   // candidates not yet assigned (already excludes `assigned`)
  busy?: Record<string, boolean>
}>()
defineEmits<{ add: [id: string]; remove: [id: string] }>()
```

**Layout:**
```
┌──────────────────────────────────────────┐
│  ●  admin                          ✕      │  ← chip row, ✕ shown on hover (or
│  ●  editor                         ✕      │    always shown but low-contrast
│  ●  viewer                    (disabled)  │    until hover)
│                                            │
│  [+ Add]                                  │  ← opens popover below
└──────────────────────────────────────────┘
```
- Each assigned item is a low-key row (not a heavy pill): a small status dot or avatar-style
  initials circle (reusing the existing `avatarGradient()` pattern when used for users),
  the label, optional `sublabel` in `text-[var(--c-text-3)]`, and a remove control on the
  right. The remove control is an icon-only button, muted until hover/focus, disabled (with
  reduced opacity, no pointer) when `disabled` is true — same visual treatment as today's
  disabled Remove button, just less heavy-handed.
- `[+ Add]` is a small ghost button below the list (or inline in the section header, matching
  `PlacesSection.vue`'s existing header "+ Add" placement convention). Clicking it opens an
  anchored popover (absolutely positioned under the button, not a full-screen `Modal.vue`):
  - A search input at the top, reusing `SearchInput.vue`'s exact markup/styling.
  - Below it, a scrollable filtered list of `available` items (filtered client-side by
    `label`/`sublabel` substring match, case-insensitive). Clicking an item emits `add` and
    removes it from the popover's own local view (the parent re-renders `available` on the
    next tick once its data reloads).
  - Empty filtered list → "No matches" placeholder text, same tone as other empty states in
    this codebase (e.g. `UserListPanel.vue`'s "No users match your search.").
  - If `available` is empty from the start (everything already assigned), the "+ Add" button
    is hidden entirely rather than opening an empty popover.
- **Closing the popover**: a `mousedown` listener on `document` added on open / removed on
  close, closing when the click target is outside the popover's root element (checked via
  `.contains()`) — plus `Escape` to close. This is a self-contained implementation detail of
  `RolePicker.vue`; no new shared "click outside" utility is introduced (no second use case
  exists yet to justify extracting one).

## Integration

**`UserDetailPanel.vue`** (replaces lines 178–232): the "Roles" section becomes
```vue
<RolePicker
  :assigned="roles.filter(r => hasRole(r.id)).map(r => ({ id: r.id, label: r.name, sublabel: r.isAdmin ? 'admin' : undefined, disabled: isSelf }))"
  :available="roles.filter(r => !hasRole(r.id)).map(r => ({ id: r.id, label: r.name, sublabel: r.isAdmin ? 'admin' : undefined }))"
  :busy="roleToggleBusy"
  @add="toggleRole"
  @remove="toggleRole"
/>
```
`toggleRole(roleId)` keeps its existing body (it already branches on `hasRole(roleId)` to call
`assignUser`/`removeUser`) — both `add`/`remove` events route to the same handler, identical to
today's single `toggleRole` callable from either button.

**`RoleEditor.vue`** (replaces lines 296–365): the "Members" section becomes the same
`RolePicker`, fed from `sortedUsers`, with each item's `label` = `user.username`, `sublabel` =
`user.displayName ?? undefined`, `disabled` = `user.id === currentUserId`, wired to the
existing `toggleMember(userId)`.

Both integrations keep every existing business rule unchanged: self-removal protection,
the "admin" sublabel, busy-state disabling during in-flight requests, and the `reload`/error
handling already in place in the parent components.

## Permission list — visual polish (`RoleEditor.vue` lines 230–294)

No structural change — still grouped rows with a checkbox, permission name, and description,
toggled by clicking the row. Adjustments:
- Increase the gap between the checkbox and the permission name slightly, and right-align (or
  visually de-emphasize via `text-[var(--c-text-3)]`, smaller size) the description text so
  the permission name reads as the primary label and the description as secondary, rather
  than both competing at the same visual weight.
- Tighten the group-label row's spacing so groups read as distinct sections at a glance,
  consistent with the new `RolePicker`'s section header style.
- No change to `togglePermission()`, `PERMISSION_GROUPS`, or any data flow.

## Default roles — seed cleanup

`packages/database/prisma/seed.ts`: remove the loop at lines 35–38 that creates the
`readonly`/`readwrite` roles. They carry zero permissions, are never granted any by the seed,
and are not referenced by name anywhere else in the codebase (`grep` across
`apps/backend/src` and `apps/dashboard/src` for `"readonly"`/`"readwrite"` returns nothing) —
they exist purely as empty rows in the Roles list with no functional effect.

Already-provisioned installations keep whatever `readonly`/`readwrite` rows already exist in
their database (the seed script only runs `upsert`, never `delete` — removing the loop simply
stops recreating them, it doesn't touch existing rows). An admin can delete them via the
existing "Delete role" button in `RoleEditor.vue` if desired. No migration is needed since this
is pure application-level seed data, not a schema change.

## Edge cases

- **Picker with zero `available` items**: "+ Add" button is omitted (see above) rather than
  showing a perpetually-empty popover.
- **Picker with zero `assigned` items**: the chip-list area shows nothing above the "+ Add"
  button — no separate "empty" placeholder needed, an empty list reads clearly enough in this
  compact format (consistent with `RoleEditor.vue`'s existing members table already only
  showing "No users" when `users.length === 0`, which is a distinct, unrelated case — having
  zero *candidates* at all, not zero *assigned*).
- **Searching and finding nothing**: "No matches" text inside the popover (see above).
- **Removing the last remaining role from a user (or last member from a role)**: unchanged
  existing behavior — no special-cased UI, the same as removing any other entry today.

## Verification

- `pnpm exec vue-tsc -b` and `pnpm exec vite build` in `apps/dashboard`.
- Manual pass: open Settings → Roles → a role, add/remove a member via the new picker, search
  for a partial username match, confirm popover closes on outside-click and on Escape; open
  Settings → Users → a user, add/remove a role the same way; confirm permission rows in
  `RoleEditor.vue` still toggle correctly and read more clearly; confirm a fresh
  `pnpm prisma db seed` no longer creates `readonly`/`readwrite` roles.
