<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import { useAuth } from '../lib/auth'

type User = {
  id: string
  username: string
  displayName: string | null
  isAdmin: boolean
  isUserManager: boolean
  sambaEnabled: boolean
  createdAt: Date | string
  capabilities: { capability: string }[]
}
type Group = { id: string; name: string; members: { userId: string }[] }
type IdentityStatus = {
  userId: string
  linuxExists: boolean
  uid?: number
  gid?: number
  groups?: string[]
  sambaEnabled: boolean
  sambaExists: boolean
  issue: string | null
}

const props = defineProps<{ user: User; groups: Group[] }>()
const emit  = defineEmits<{ back: []; reload: [] }>()

const { currentUserId, isAdmin } = useAuth()

// ── Identity status (Linux + Samba, as the OS actually sees it) ───────────────
const identity        = ref<IdentityStatus | null>(null)
const identityLoading = ref(true)
const identityError   = ref('')
const sambaBusy        = ref(false)

async function loadIdentity() {
  identityLoading.value = true
  identityError.value = ''
  try {
    const all = await trpc.user.identityStatus.query()
    identity.value = (all as IdentityStatus[]).find(s => s.userId === props.user.id) ?? null
  } catch (e: any) {
    identityError.value = e?.message ?? 'Failed to load identity status'
  } finally {
    identityLoading.value = false
  }
}

async function toggleSamba() {
  if (isSelf.value || sambaBusy.value || !identity.value) return
  sambaBusy.value = true
  try {
    await trpc.user.setSambaEnabled.mutate({ userId: props.user.id, sambaEnabled: !identity.value.sambaEnabled })
    await loadIdentity()
    emit('reload')
  } catch (e: any) {
    identityError.value = e?.message ?? 'Failed to update'
  } finally {
    sambaBusy.value = false
  }
}

onMounted(loadIdentity)

const form        = reactive({ displayName: props.user.displayName ?? '' })
const saveLoading = ref(false)
const saveError   = ref('')
const saveSuccess = ref(false)

const accountBusy  = ref<Record<'isAdmin' | 'isUserManager', boolean>>({ isAdmin: false, isUserManager: false })
const accountError = ref('')

const capabilityBusy  = ref<Record<'storage', boolean>>({ storage: false })
const capabilityError = ref('')

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

const memberGroups = computed(() =>
  props.groups.filter(g => g.members.some(m => m.userId === props.user.id)),
)

async function save() {
  saveError.value = ''
  saveSuccess.value = false
  saveLoading.value = true
  try {
    await trpc.user.update.mutate({
      userId:      props.user.id,
      displayName: form.displayName.trim() || null,
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

async function toggleAccountFlag(flag: 'isAdmin' | 'isUserManager') {
  if (isSelf.value || accountBusy.value[flag]) return
  accountBusy.value[flag] = true
  accountError.value = ''
  try {
    const next = !props.user[flag]
    await trpc.user.update.mutate(
      flag === 'isAdmin'
        ? { userId: props.user.id, isAdmin: next }
        : { userId: props.user.id, isUserManager: next },
    )
    emit('reload')
  } catch (e: any) {
    accountError.value = e?.message ?? 'Failed to update'
  } finally {
    accountBusy.value[flag] = false
  }
}

// Named distinctly from useAuth()'s hasCapability (not imported in this file) —
// that one checks the viewing session's own JWT claims; this one checks the
// capabilities of the `user` prop being edited, read from userSelect's output.
function userHasCapability(capability: 'storage'): boolean {
  return props.user.capabilities.some(c => c.capability === capability)
}

async function toggleCapability(capability: 'storage') {
  if (isSelf.value || capabilityBusy.value[capability]) return
  capabilityBusy.value[capability] = true
  capabilityError.value = ''
  try {
    await trpc.user.setCapability.mutate({
      userId: props.user.id,
      capability,
      granted: !userHasCapability(capability),
    })
    emit('reload')
  } catch (e: any) {
    capabilityError.value = e?.message ?? 'Failed to update'
  } finally {
    capabilityBusy.value[capability] = false
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
            class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium border border-[var(--c-border-strong)] text-[var(--c-text-3)]">you</span>
          <span v-if="user.isAdmin"
            class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-[var(--c-accent-subtle)] text-[var(--c-accent)]">admin</span>
          <span v-if="user.isUserManager" class="badge badge-violet">manager</span>
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
      </div>

      <p v-if="saveError" class="text-[var(--c-danger)] text-xs">{{ saveError }}</p>

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

    <!-- ── Account (admin only) ──────────────────────────────────────────────── -->
    <div v-if="isAdmin" class="space-y-3">
      <h4 class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Account</h4>

      <div class="bg-[var(--c-surface)] border border-[var(--c-border)] rounded-xl divide-y divide-[var(--c-border)]">
        <label class="flex items-center justify-between gap-4 px-4 py-3 cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': isSelf }">
          <div>
            <p class="text-sm text-[var(--c-text-1)]">Admin</p>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">Full access to every place, permission, and settings screen.</p>
          </div>
          <input
            type="checkbox"
            :checked="user.isAdmin"
            :disabled="isSelf || accountBusy.isAdmin"
            @change="toggleAccountFlag('isAdmin')"
            class="shrink-0"
          />
        </label>
        <label class="flex items-center justify-between gap-4 px-4 py-3 cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': isSelf }">
          <div>
            <p class="text-sm text-[var(--c-text-1)]">User manager</p>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">Can create, edit, and delete other user accounts.</p>
          </div>
          <input
            type="checkbox"
            :checked="user.isUserManager"
            :disabled="isSelf || accountBusy.isUserManager"
            @change="toggleAccountFlag('isUserManager')"
            class="shrink-0"
          />
        </label>
        <label class="flex items-center justify-between gap-4 px-4 py-3 cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': isSelf }">
          <div>
            <p class="text-sm text-[var(--c-text-1)]">Storage admin</p>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">Can manage disks, RAID, LVM, and partitions.</p>
          </div>
          <input
            type="checkbox"
            :checked="userHasCapability('storage')"
            :disabled="isSelf || capabilityBusy.storage"
            @change="toggleCapability('storage')"
            class="shrink-0"
          />
        </label>
      </div>

      <p class="text-xs text-[var(--c-text-3)] px-0.5">Access changes apply immediately, but menus update after the account's next sign-in.</p>
      <p v-if="isSelf" class="text-xs text-[var(--c-text-3)] px-0.5">You can't change your own access.</p>
      <p v-if="accountError" class="text-[var(--c-danger)] text-xs px-0.5">{{ accountError }}</p>
      <p v-if="capabilityError" class="text-[var(--c-danger)] text-xs px-0.5">{{ capabilityError }}</p>
    </div>

    <!-- ── Identity (Linux + Samba, as the OS actually sees it) ─────────────── -->
    <div v-if="isAdmin" class="space-y-3">
      <h4 class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Identity</h4>

      <div v-if="identityLoading" class="text-xs text-[var(--c-text-3)]">Loading…</div>
      <p v-else-if="identityError" class="text-[var(--c-danger)] text-xs">{{ identityError }}</p>

      <div v-else-if="identity" class="bg-[var(--c-surface)] border border-[var(--c-border)] rounded-xl divide-y divide-[var(--c-border)]">
        <!-- HSI identity -->
        <div class="flex items-center justify-between gap-4 px-4 py-3">
          <p class="text-sm text-[var(--c-text-1)]">HSI identity</p>
          <span class="text-xs font-mono text-[var(--c-text-2)]">{{ user.username }}</span>
        </div>

        <!-- Linux identity -->
        <div class="flex items-start justify-between gap-4 px-4 py-3">
          <div>
            <p class="text-sm text-[var(--c-text-1)]">Linux identity</p>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">Backs filesystem ownership for this account's uploads and edits.</p>
          </div>
          <div class="text-right shrink-0">
            <template v-if="identity.linuxExists">
              <div class="text-xs font-mono text-[var(--c-text-2)]">uid={{ identity.uid }} gid={{ identity.gid }}</div>
              <div v-if="identity.groups?.length" class="text-[11px] text-[var(--c-text-3)] mt-0.5">{{ identity.groups.join(', ') }}</div>
            </template>
            <span v-else class="text-xs text-[var(--c-danger)]">Missing</span>
          </div>
        </div>

        <!-- Samba identity -->
        <label class="flex items-center justify-between gap-4 px-4 py-3 cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': isSelf }">
          <div>
            <p class="text-sm text-[var(--c-text-1)]">Samba identity</p>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">
              Whether this account should be reachable over SMB at all.
              <span v-if="identity.sambaExists" class="text-[var(--c-success)]">Account exists.</span>
              <span v-else class="text-[var(--c-text-3)]">No account on the system yet.</span>
            </p>
          </div>
          <input
            type="checkbox"
            :checked="identity.sambaEnabled"
            :disabled="isSelf || sambaBusy"
            @change="toggleSamba"
            class="shrink-0"
          />
        </label>
      </div>

      <p v-if="identity?.issue" class="text-xs text-[var(--c-warning)] px-0.5">{{ identity.issue }}</p>
    </div>

    <!-- ── Groups (read-only) ───────────────────────────────────────────────── -->
    <div class="space-y-3">
      <h4 class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Groups</h4>

      <div class="flex flex-wrap gap-1.5">
        <span v-for="g in memberGroups" :key="g.id" class="badge badge-violet">{{ g.name }}</span>
        <span v-if="memberGroups.length === 0" class="text-[var(--c-text-3)] text-xs italic">No groups.</span>
      </div>
      <p class="text-xs text-[var(--c-text-3)]">Group membership is managed from the Groups tab.</p>
    </div>

    <!-- ── Danger zone ─────────────────────────────────────────────────────── -->
    <div v-if="!isSelf" class="space-y-3 pt-2">
      <h4 class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-danger)]/70">Danger zone</h4>

      <div class="border border-[var(--c-danger)]/20 rounded-xl p-4 bg-[var(--c-danger)]/5">
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-[var(--c-text-1)]">Delete account</p>
            <p class="text-xs text-[var(--c-text-3)] mt-0.5">Permanently remove this user and all associated data.</p>
          </div>

          <template v-if="!deleteConfirm">
            <button
              @click="deleteConfirm = true"
              class="btn btn-sm shrink-0 text-[var(--c-danger)] border border-[var(--c-danger)]/30 hover:bg-[var(--c-danger-subtle)] transition-colors"
            >Delete</button>
          </template>
          <template v-else>
            <div class="flex items-center gap-2 shrink-0">
              <span class="text-xs text-[var(--c-danger)]">Are you sure?</span>
              <button
                @click="deleteUser"
                :disabled="deleteBusy"
                class="px-2.5 py-1 text-xs rounded-lg bg-[var(--c-danger)] text-[var(--c-accent-fg)] hover:opacity-85 disabled:opacity-40 transition-colors"
              >{{ deleteBusy ? '…' : 'Yes, delete' }}</button>
              <button
                @click="deleteConfirm = false"
                class="px-2.5 py-1 text-xs rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] transition-colors"
              >Cancel</button>
            </div>
          </template>
        </div>
        <p v-if="deleteError" class="mt-2 text-[var(--c-danger)] text-xs">{{ deleteError }}</p>
      </div>
    </div>

  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 300ms; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
