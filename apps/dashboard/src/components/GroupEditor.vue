<script setup lang="ts">
import { ref, computed } from 'vue'
import { trpc } from '../lib/trpc'
import GroupPicker, { type PickerItem } from './ui/GroupPicker.vue'

type Group = {
  id: string
  name: string
  createdAt: string
  members: { userId: string }[]
}
type User = {
  id: string
  username: string
  displayName?: string | null
  isAdmin: boolean
  isUserManager: boolean
}

const props = defineProps<{ group: Group; users: User[] }>()
const emit  = defineEmits<{ back: []; reload: [] }>()

// ── State ─────────────────────────────────────────────────────────────────────
const sortedUsers   = computed(() =>
  [...props.users].sort((a, b) => {
    const aHas = isMember(a) ? 0 : 1
    const bHas = isMember(b) ? 0 : 1
    return aHas - bHas || a.username.localeCompare(b.username)
  }),
)
const memberBusy    = ref<Record<string, boolean>>({})
const deleteBusy    = ref(false)
const deleteConfirm = ref(false)
const error         = ref('')

// ── Delete group ──────────────────────────────────────────────────────────────
async function deleteGroup() {
  deleteBusy.value = true
  try {
    await trpc.group.delete.mutate({ id: props.group.id })
    emit('back')
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to delete'
  } finally {
    deleteBusy.value = false
    deleteConfirm.value = false
  }
}

// ── Members ───────────────────────────────────────────────────────────────────
function isMember(user: User) {
  return props.group.members.some(m => m.userId === user.id)
}

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
    .filter(u => isMember(u))
    .map(u => ({
      id: u.id,
      label: u.username,
      avatarText: u.username.slice(0, 2).toUpperCase(),
      avatarClass: avatarGradient(u.username),
    })),
)
const availableMembers = computed<PickerItem[]>(() =>
  sortedUsers.value
    .filter(u => !isMember(u))
    .map(u => ({
      id: u.id,
      label: u.username,
      avatarText: u.username.slice(0, 2).toUpperCase(),
      avatarClass: avatarGradient(u.username),
    })),
)

async function toggleMember(userId: string) {
  if (memberBusy.value[userId]) return
  memberBusy.value[userId] = true
  try {
    const ids = new Set(props.group.members.map(m => m.userId))
    ids.has(userId) ? ids.delete(userId) : ids.add(userId)
    await trpc.group.setMembers.mutate({ id: props.group.id, userIds: [...ids] })
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
        title="Back to groups"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/>
        </svg>
      </button>

      <!-- Name -->
      <div class="flex items-center gap-2 flex-1 min-w-0">
        <span class="text-base font-semibold text-[var(--c-text-1)] truncate">{{ group.name }}</span>
      </div>

      <!-- Delete -->
      <template v-if="!deleteConfirm">
        <button
          @click="deleteConfirm = true"
          class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-accent)] hover:bg-[var(--c-accent-subtle)] transition-colors shrink-0"
          title="Delete group"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
        </button>
      </template>
      <template v-else>
        <span class="text-xs text-[var(--c-danger)] shrink-0">Delete?</span>
        <button
          @click="deleteGroup"
          :disabled="deleteBusy"
          class="text-xs px-2 py-1 rounded-sm bg-[var(--c-danger)]/15 text-[var(--c-danger)] hover:bg-[var(--c-danger)]/25 transition-colors disabled:opacity-40"
        >Yes</button>
        <button
          @click="deleteConfirm = false"
          class="text-xs px-2 py-1 rounded-sm text-[var(--c-text-3)] hover:text-[var(--c-text-2)] transition-colors"
        >No</button>
      </template>
    </div>

    <p v-if="error" class="text-[var(--c-accent)] text-xs px-0.5">{{ error }}</p>

    <!-- ── Members ─────────────────────────────────────────────────────────── -->
    <div class="space-y-3">
      <div class="flex items-center justify-between px-0.5">
        <h4 class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Members</h4>
        <span class="text-xs text-[var(--c-text-3)]">{{ sortedUsers.filter(u => isMember(u)).length }} / {{ users.length }}</span>
      </div>

      <p v-if="users.length === 0" class="text-xs text-[var(--c-text-3)] italic px-0.5">No users</p>

      <GroupPicker
        v-else
        :assigned="assignedMembers"
        :available="availableMembers"
        :busy="memberBusy"
        @add="toggleMember"
        @remove="toggleMember"
      />
    </div>

  </div>
</template>
