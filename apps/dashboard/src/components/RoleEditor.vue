<script setup lang="ts">
import { ref, computed } from 'vue'
import { trpc } from '../lib/trpc'
import { useAuth } from '../lib/auth'

type Role = {
  id: string
  name: string
  isAdmin: boolean
  userRoles: { userId: string }[]
  permissions: { permission: { name: string } }[]
}
type User = {
  id: string
  username: string
  displayName?: string | null
  userRoles: { role: { id: string } }[]
}

const props = defineProps<{ role: Role; users: User[] }>()
const emit  = defineEmits<{ back: []; reload: [] }>()

const { currentUserId } = useAuth()

// ── Permission groups ─────────────────────────────────────────────────────────
const PERMISSION_GROUPS = [
  {
    id: 'users',
    label: 'Users',
    icon: 'M17 20h5v-2a4 4 0 00-5.916-3.5M9 20H4v-2a4 4 0 015.916-3.5M15 7a3 3 0 11-6 0 3 3 0 016 0zM21 10a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z',
    permissions: [
      { name: 'users.manage', desc: 'Create, edit and delete users' },
      { name: 'users.*',      desc: 'All user permissions' },
    ],
  },
  {
    id: 'places',
    label: 'Places',
    icon: 'M3 7a2 2 0 012-2h3.586a1 1 0 01.707.293L11 7h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
    permissions: [
      { name: 'places.manage', desc: 'Create, edit and delete places' },
      { name: 'places.*',      desc: 'All place permissions' },
    ],
  },
  {
    id: 'files',
    label: 'Files',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    permissions: [
      { name: 'files.read',   desc: 'Read files' },
      { name: 'files.write',  desc: 'Write files' },
      { name: 'files.delete', desc: 'Delete files' },
      { name: 'files.*',      desc: 'All file operations' },
    ],
  },
  {
    id: 'containers',
    label: 'Containers',
    icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
    permissions: [
      { name: 'container.view',   desc: 'View container list and details' },
      { name: 'container.create', desc: 'Create new containers' },
      { name: 'container.delete', desc: 'Delete containers' },
      { name: 'container.manage', desc: 'Start, stop and restart containers' },
      { name: 'container.*',      desc: 'All container operations' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    permissions: [
      { name: '*.*', desc: 'Full access — grants all permissions' },
    ],
  },
]

// ── State ─────────────────────────────────────────────────────────────────────
const grantedNames  = computed(() => new Set(props.role.permissions.map(rp => rp.permission.name)))
const sortedUsers   = computed(() =>
  [...props.users].sort((a, b) => {
    const aHas = userHasRole(a) ? 0 : 1
    const bHas = userHasRole(b) ? 0 : 1
    return aHas - bHas || a.username.localeCompare(b.username)
  }),
)
const permBusy      = ref<Record<string, boolean>>({})
const memberBusy    = ref<Record<string, boolean>>({})
const adminBusy     = ref(false)
const deleteBusy    = ref(false)
const deleteConfirm = ref(false)
const error         = ref('')

// ── Permission actions ────────────────────────────────────────────────────────
async function togglePermission(permName: string) {
  if (permBusy.value[permName]) return
  permBusy.value[permName] = true
  error.value = ''
  try {
    if (grantedNames.value.has(permName)) {
      await trpc.role.removePermission.mutate({ roleId: props.role.id, permissionName: permName })
    } else {
      await trpc.role.addPermission.mutate({ roleId: props.role.id, permissionName: permName })
    }
    emit('reload')
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to update permission'
  } finally {
    permBusy.value[permName] = false
  }
}

// ── Admin toggle ──────────────────────────────────────────────────────────────
async function toggleAdmin() {
  adminBusy.value = true
  try {
    await trpc.role.update.mutate({ id: props.role.id, isAdmin: !props.role.isAdmin })
    emit('reload')
  } catch (e: any) {
    error.value = e?.message ?? 'Failed'
  } finally {
    adminBusy.value = false
  }
}

// ── Delete role ───────────────────────────────────────────────────────────────
async function deleteRole() {
  deleteBusy.value = true
  try {
    await trpc.role.delete.mutate({ id: props.role.id })
    emit('back')
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to delete'
  } finally {
    deleteBusy.value = false
    deleteConfirm.value = false
  }
}

// ── Members ───────────────────────────────────────────────────────────────────
function userHasRole(user: User) {
  return user.userRoles.some(ur => ur.role.id === props.role.id)
}

async function toggleMember(userId: string) {
  if (memberBusy.value[userId]) return
  memberBusy.value[userId] = true
  const user = props.users.find(u => u.id === userId)!
  try {
    if (userHasRole(user)) {
      await trpc.role.removeUser.mutate({ userId, roleId: props.role.id })
    } else {
      await trpc.role.assignUser.mutate({ userId, roleId: props.role.id })
    }
    emit('reload')
  } catch (e: any) {
    error.value = e?.message ?? 'Failed'
  } finally {
    memberBusy.value[userId] = false
  }
}
</script>

<template>
  <div class="space-y-7">

    <!-- ── Header ─────────────────────────────────────────────────────────── -->
    <div class="flex items-center gap-2.5">

      <!-- Back -->
      <button
        @click="$emit('back')"
        class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors shrink-0"
        title="Back to roles"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/>
        </svg>
      </button>

      <!-- Name + badges -->
      <div class="flex items-center gap-2 flex-1 min-w-0">
        <span class="text-base font-semibold text-[var(--c-text-1)] truncate">{{ role.name }}</span>
        <span
          v-if="role.isAdmin"
          class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--c-accent-subtle)] text-[var(--c-accent)] shrink-0"
        >admin</span>
      </div>

      <!-- Admin toggle -->
      <button
        @click="toggleAdmin"
        :disabled="adminBusy"
        :class="[
          'text-xs px-2.5 py-1 rounded-lg border transition-colors shrink-0 disabled:opacity-40',
          role.isAdmin
            ? 'border-[var(--c-border-strong)] text-[var(--c-accent)] hover:border-[var(--c-accent)]/40 hover:text-[var(--c-accent)]'
            : 'border-[var(--c-border-strong)] text-[var(--c-text-3)] hover:border-[var(--c-accent)] hover:text-[var(--c-accent)]',
        ]"
      >{{ role.isAdmin ? 'Revoke admin' : 'Grant admin' }}</button>

      <!-- Delete -->
      <template v-if="!deleteConfirm">
        <button
          @click="deleteConfirm = true"
          class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-accent)] hover:bg-[var(--c-accent-subtle)] transition-colors shrink-0"
          title="Delete role"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
        </button>
      </template>
      <template v-else>
        <span class="text-xs text-[var(--c-accent)] shrink-0">Delete?</span>
        <button
          @click="deleteRole"
          :disabled="deleteBusy"
          class="text-xs px-2 py-1 rounded bg-[var(--c-accent)]/15 text-[var(--c-accent)] hover:bg-[var(--c-accent)]/25 transition-colors disabled:opacity-40"
        >Yes</button>
        <button
          @click="deleteConfirm = false"
          class="text-xs px-2 py-1 rounded text-[var(--c-text-3)] hover:text-[var(--c-text-2)] transition-colors"
        >No</button>
      </template>
    </div>

    <p v-if="error" class="text-[var(--c-accent)] text-xs px-0.5">{{ error }}</p>

    <!-- ── Permissions ─────────────────────────────────────────────────────── -->
    <div class="space-y-5">
      <h4 class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Permissions</h4>

      <!-- Admin notice -->
      <div
        v-if="role.isAdmin"
        class="px-3 py-2.5 rounded-xl bg-[var(--c-accent-subtle)] border border-[var(--c-border-strong)] text-xs text-[var(--c-accent)]"
      >
        Admin roles have implicit access to all resources — explicit permissions are ignored.
      </div>

      <!-- Permission groups -->
      <div
        v-for="group in PERMISSION_GROUPS"
        :key="group.id"
        class="space-y-1"
      >
        <!-- Group label -->
        <div class="flex items-center gap-1.5 px-0.5 mb-2">
          <svg class="w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" :d="group.icon"/>
          </svg>
          <span class="text-[11px] font-medium text-[var(--c-text-3)]">{{ group.label }}</span>
        </div>

        <!-- Permission rows -->
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
          <!-- Checkbox -->
          <span
            :class="[
              'w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-all',
              permBusy[perm.name] ? 'opacity-40' : '',
              grantedNames.has(perm.name)
                ? 'bg-[var(--c-success)] border-[var(--c-success)]'
                : 'border-[var(--c-border-strong)] hover:border-[var(--c-border-strong)]',
            ]"
          >
            <svg
              v-if="grantedNames.has(perm.name)"
              class="w-2.5 h-2.5 text-white"
              fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3.5"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
            </svg>
          </span>

          <!-- Permission name + description -->
          <div class="flex-1 min-w-0 flex items-baseline gap-2.5">
            <code class="text-xs font-mono text-[var(--c-text-2)] shrink-0">{{ perm.name }}</code>
            <span class="text-xs text-[var(--c-text-3)] truncate">{{ perm.desc }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Members ─────────────────────────────────────────────────────────── -->
    <div class="space-y-3">
      <div class="flex items-center justify-between px-0.5">
        <h4 class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Members</h4>
        <span class="text-xs text-[var(--c-text-3)]">{{ sortedUsers.filter(u => userHasRole(u)).length }} / {{ users.length }}</span>
      </div>

      <div class="divide-y divide-[var(--c-border)] border border-[var(--c-border)] rounded-xl overflow-hidden">

        <div v-if="users.length === 0" class="px-4 py-4 text-xs text-[var(--c-text-3)] italic">No users</div>

        <div
          v-for="user in sortedUsers"
          :key="user.id"
          class="flex items-center gap-3 px-4 py-2.5 bg-[var(--c-bg)] hover:bg-[var(--c-surface)] transition-colors"
        >
          <!-- Avatar -->
          <div :class="[
            'w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0',
            userHasRole(user) ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]' : 'bg-[var(--c-surface-deep)] text-[var(--c-text-3)]',
          ]">
            {{ user.username.slice(0, 2).toUpperCase() }}
          </div>

          <!-- Name -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5">
              <span :class="['text-sm font-medium truncate', userHasRole(user) ? 'text-[var(--c-text-1)]' : 'text-[var(--c-text-3)]']">
                {{ user.username }}
              </span>
              <span v-if="user.id === currentUserId" class="text-[10px] text-[var(--c-text-3)]">(you)</span>
            </div>
            <div v-if="user.displayName" class="text-xs text-[var(--c-text-3)] truncate">{{ user.displayName }}</div>
          </div>

          <!-- Action -->
          <div class="shrink-0">
            <button
              v-if="userHasRole(user)"
              :disabled="user.id === currentUserId || memberBusy[user.id]"
              @click="user.id !== currentUserId && toggleMember(user.id)"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium
                     text-[var(--c-text-3)] border border-[var(--c-border-strong)]
                     hover:text-[var(--c-accent)] hover:border-[var(--c-accent)]/40 hover:bg-[var(--c-accent)]/8
                     disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
              Remove
            </button>
            <button
              v-else
              :disabled="memberBusy[user.id]"
              @click="toggleMember(user.id)"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium
                     text-[var(--c-text-3)] border border-[var(--c-border-strong)]
                     hover:text-[var(--c-accent)] hover:border-[var(--c-accent)] hover:bg-[var(--c-accent-subtle)]
                     disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
              </svg>
              Add
            </button>
          </div>
        </div>

      </div>
    </div>

  </div>
</template>
