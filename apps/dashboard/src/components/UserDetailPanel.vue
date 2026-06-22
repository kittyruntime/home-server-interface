<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import { trpc } from '../lib/trpc'
import { useAuth } from '../lib/auth'
import RolePicker, { type PickerItem } from './ui/RolePicker.vue'

type UserRole = { role: { id: string; name: string; isAdmin: boolean; permissions: { permission: { name: string } }[] } }
type User = {
  id: string
  username: string
  displayName: string | null
  linuxUsername: string | null
  createdAt: Date | string
  userRoles: UserRole[]
}
type RoleBasic = { id: string; name: string; isAdmin: boolean }

const props = defineProps<{ user: User; roles: RoleBasic[] }>()
const emit  = defineEmits<{ back: []; reload: [] }>()

const { currentUserId } = useAuth()

const form        = reactive({ displayName: props.user.displayName ?? '', linuxUsername: props.user.linuxUsername ?? '' })
const saveLoading = ref(false)
const saveError   = ref('')
const saveSuccess = ref(false)

const roleToggleBusy = ref<Record<string, boolean>>({})
const roleError      = ref('')

const deleteBusy    = ref(false)
const deleteConfirm = ref(false)
const deleteError   = ref('')

const isSelf = computed(() => props.user.id === currentUserId.value)

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

function hasRole(roleId: string) {
  return props.user.userRoles.some(ur => ur.role.id === roleId)
}

function userIsAdmin() { return props.user.userRoles.some(ur => ur.role.isAdmin) }

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

async function save() {
  saveError.value = ''
  saveSuccess.value = false
  saveLoading.value = true
  try {
    await trpc.user.update.mutate({
      userId:        props.user.id,
      displayName:   form.displayName.trim() || null,
      linuxUsername: form.linuxUsername.trim() || null,
    })
    saveSuccess.value = true
    emit('reload')
    setTimeout(() => { saveSuccess.value = false }, 2000)
  } catch (e: any) {
    saveError.value = e?.message ?? 'Failed to save'
  } finally {
    saveLoading.value = false
  }
}

async function toggleRole(roleId: string) {
  if (roleToggleBusy.value[roleId]) return
  roleToggleBusy.value[roleId] = true
  roleError.value = ''
  try {
    if (hasRole(roleId)) await trpc.role.removeUser.mutate({ userId: props.user.id, roleId })
    else                  await trpc.role.assignUser.mutate({ userId: props.user.id, roleId })
    emit('reload')
  } catch (e: any) {
    roleError.value = e?.message ?? 'Failed to update role'
  } finally {
    roleToggleBusy.value[roleId] = false
  }
}

async function deleteUser() {
  deleteBusy.value = true
  deleteError.value = ''
  try {
    await trpc.user.delete.mutate({ userId: props.user.id })
    emit('back')
  } catch (e: any) {
    deleteError.value = e?.message ?? 'Failed to delete user'
  } finally {
    deleteBusy.value = false
    deleteConfirm.value = false
  }
}
</script>

<template>
  <div class="space-y-8">

    <!-- ── Header ─────────────────────────────────────────────────────────── -->
    <div class="flex items-center gap-3">
      <button
        @click="$emit('back')"
        class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors shrink-0"
        title="Back to users"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/>
        </svg>
      </button>

      <div :class="['w-9 h-9 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-xs font-bold shrink-0', avatarGradient(user.username)]">
        {{ user.username.slice(0, 2).toUpperCase() }}
      </div>

      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-base font-semibold text-[var(--c-text-1)]">{{ user.username }}</span>
          <span v-if="isSelf"
            class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border border-[var(--c-border-strong)] text-[var(--c-text-3)]">you</span>
          <span v-if="userIsAdmin()"
            class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--c-accent-subtle)] text-[var(--c-accent)]">admin</span>
        </div>
        <div v-if="user.displayName" class="text-xs text-[var(--c-text-3)] mt-0.5">{{ user.displayName }}</div>
      </div>
    </div>

    <!-- ── Profile fields ──────────────────────────────────────────────────── -->
    <div class="space-y-4">
      <h4 class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Profile</h4>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div class="space-y-1.5">
          <label class="block text-xs text-[var(--c-text-3)]">Display name</label>
          <input
            v-model="form.displayName"
            placeholder="Full name"
            class="ui-input"
          />
        </div>
        <div class="space-y-1.5">
          <label class="block text-xs text-[var(--c-text-3)]">Linux username</label>
          <input
            v-model="form.linuxUsername"
            placeholder="linux_user"
            class="ui-input font-mono"
          />
        </div>
      </div>

      <p v-if="saveError" class="text-[var(--c-accent)] text-xs">{{ saveError }}</p>

      <div class="flex items-center gap-3">
        <button
          @click="save"
          :disabled="saveLoading"
          class="btn btn-primary btn-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {{ saveLoading ? 'Saving…' : 'Save changes' }}
        </button>
        <transition name="fade">
          <span v-if="saveSuccess" class="text-xs text-[var(--c-success)] flex items-center gap-1">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
            </svg>
            Saved
          </span>
        </transition>
      </div>
    </div>

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

    <!-- ── Danger zone ─────────────────────────────────────────────────────── -->
    <div v-if="!isSelf" class="space-y-3 pt-2">
      <h4 class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-accent)]/70">Danger zone</h4>

      <div class="border border-[var(--c-accent)]/20 rounded-xl p-4 bg-[var(--c-accent)]/5">
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-[var(--c-text-1)]">Delete account</p>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">Permanently remove this user and all associated data.</p>
          </div>

          <template v-if="!deleteConfirm">
            <button
              @click="deleteConfirm = true"
              class="btn btn-sm shrink-0 text-[var(--c-accent)] border border-[var(--c-accent)]/30 hover:bg-[var(--c-accent-subtle)] transition-colors"
            >Delete</button>
          </template>
          <template v-else>
            <div class="flex items-center gap-2 shrink-0">
              <span class="text-xs text-[var(--c-accent)]">Are you sure?</span>
              <button
                @click="deleteUser"
                :disabled="deleteBusy"
                class="px-2.5 py-1 text-xs rounded-lg bg-[var(--c-accent)] text-[var(--c-accent-fg)] hover:opacity-85 disabled:opacity-40 transition-colors"
              >{{ deleteBusy ? '…' : 'Yes, delete' }}</button>
              <button
                @click="deleteConfirm = false"
                class="px-2.5 py-1 text-xs rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors"
              >Cancel</button>
            </div>
          </template>
        </div>
        <p v-if="deleteError" class="mt-2 text-[var(--c-accent)] text-xs">{{ deleteError }}</p>
      </div>
    </div>

  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 300ms; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
