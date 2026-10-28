<script setup lang="ts">
import { Checkbox } from '@/components/ui/checkbox'
import LoadingState from './ui/LoadingState.vue'
import { ref, reactive, computed, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import { applyPlanned } from '../lib/plan'
import { useAuth } from '../lib/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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

// Named distinctly from useAuth()'s hasCapability (not imported in this file):
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
    await applyPlanned('user.delete', { userId: props.user.id }, {
      domain: 'users', title: `Delete ${props.user.username}`, actionLabel: 'Delete user', danger: true,
    })
    emit('back')
  } catch (e: any) {
    if (e?.message === '') return // cancelled in the plan dialog
    deleteError.value = e?.message ?? 'Failed to delete user'
  } finally {
    deleteBusy.value = false
  }
}
</script>

<template>
  <div class="space-y-8">

    <!-- ── Header ─────────────────────────────────────────────────────────── -->
    <div class="flex items-center gap-3">
      <button
        @click="$emit('back')"
        class="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
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
          <span class="text-base font-semibold text-foreground">{{ user.username }}</span>
          <span v-if="isSelf"
            class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-2xs font-medium border border-input text-muted-foreground">you</span>
          <span v-if="user.isAdmin"
            class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-2xs font-medium bg-primary/10 text-primary">admin</span>
          <Badge variant="secondary" v-if="user.isUserManager">manager</Badge>
        </div>
        <div v-if="user.displayName" class="text-xs text-muted-foreground mt-0.5">{{ user.displayName }}</div>
      </div>
    </div>

    <!-- ── Profile fields ──────────────────────────────────────────────────── -->
    <div class="space-y-4">
      <h4 class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">Profile</h4>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div class="space-y-1.5">
          <label class="block text-xs text-muted-foreground">Display name</label>
          <Input
            v-model="form.displayName"
            placeholder="Full name"
          />
        </div>
      </div>

      <p v-if="saveError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ saveError }}</p>

      <div class="flex items-center gap-3">
        <Button size="sm"
          @click="save"
          :disabled="saveLoading"
          class="disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {{ saveLoading ? 'Saving…' : 'Save changes' }}
        </Button>
        <transition name="fade">
          <span v-if="saveSuccess" class="text-xs text-success flex items-center gap-1">
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
      <h4 class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">Account</h4>

      <div class="bg-card border border-border rounded-xl divide-y divide-border">
        <label class="flex items-center justify-between gap-4 px-4 py-3 cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': isSelf }">
          <div>
            <p class="text-sm text-foreground">Admin</p>
            <p class="text-xs text-muted-foreground mt-0.5">Full access to every place, permission, and settings screen.</p>
          </div>
          <Checkbox :model-value="user.isAdmin" :disabled="isSelf || accountBusy.isAdmin" @update:model-value="toggleAccountFlag('isAdmin')" class="shrink-0" />
        </label>
        <label class="flex items-center justify-between gap-4 px-4 py-3 cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': isSelf }">
          <div>
            <p class="text-sm text-foreground">User manager</p>
            <p class="text-xs text-muted-foreground mt-0.5">Can create, edit, and delete other user accounts.</p>
          </div>
          <Checkbox :model-value="user.isUserManager" :disabled="isSelf || accountBusy.isUserManager" @update:model-value="toggleAccountFlag('isUserManager')" class="shrink-0" />
        </label>
        <label class="flex items-center justify-between gap-4 px-4 py-3 cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': isSelf }">
          <div>
            <p class="text-sm text-foreground">Storage admin</p>
            <p class="text-xs text-muted-foreground mt-0.5">Can manage disks, RAID, LVM, and partitions.</p>
          </div>
          <Checkbox :model-value="userHasCapability('storage')" :disabled="isSelf || capabilityBusy.storage" @update:model-value="toggleCapability('storage')" class="shrink-0" />
        </label>
      </div>

      <p class="text-xs text-muted-foreground px-0.5">Access changes apply immediately, but menus update after the account's next sign-in.</p>
      <p v-if="isSelf" class="text-xs text-muted-foreground px-0.5">You can't change your own access.</p>
      <p v-if="accountError" role="alert" class="px-0.5 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ accountError }}</p>
      <p v-if="capabilityError" role="alert" class="px-0.5 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ capabilityError }}</p>
    </div>

    <!-- ── Identity (Linux + Samba, as the OS actually sees it) ─────────────── -->
    <div v-if="isAdmin" class="space-y-3">
      <h4 class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">Identity</h4>

      <LoadingState v-if="identityLoading" variant="inline" class="text-xs" />
      <p v-else-if="identityError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ identityError }}</p>

      <div v-else-if="identity" class="bg-card border border-border rounded-xl divide-y divide-border">
        <!-- HSI identity -->
        <div class="flex items-center justify-between gap-4 px-4 py-3">
          <p class="text-sm text-foreground">HSI identity</p>
          <span class="text-xs font-mono text-foreground/80">{{ user.username }}</span>
        </div>

        <!-- Linux identity -->
        <div class="flex items-start justify-between gap-4 px-4 py-3">
          <div>
            <p class="text-sm text-foreground">Linux identity</p>
            <p class="text-xs text-muted-foreground mt-0.5">Backs filesystem ownership for this account's uploads and edits.</p>
          </div>
          <div class="text-right shrink-0">
            <template v-if="identity.linuxExists">
              <div class="text-xs font-mono text-foreground/80">uid={{ identity.uid }} gid={{ identity.gid }}</div>
              <div v-if="identity.groups?.length" class="text-2xs text-muted-foreground mt-0.5">{{ identity.groups.join(', ') }}</div>
            </template>
            <span v-else class="text-xs text-destructive">Missing</span>
          </div>
        </div>

        <!-- Samba identity -->
        <label class="flex items-center justify-between gap-4 px-4 py-3 cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': isSelf }">
          <div>
            <p class="text-sm text-foreground">Samba identity</p>
            <p class="text-xs text-muted-foreground mt-0.5">
              Whether this account should be reachable over SMB at all.
              <span v-if="identity.sambaExists" class="text-success">Account exists.</span>
              <span v-else class="text-muted-foreground">No account on the system yet.</span>
            </p>
          </div>
          <Checkbox :model-value="identity.sambaEnabled" :disabled="isSelf || sambaBusy" @update:model-value="toggleSamba" class="shrink-0" />
        </label>
      </div>

      <p v-if="identity?.issue" class="text-xs text-warning px-0.5">{{ identity.issue }}</p>
    </div>

    <!-- ── Groups (read-only) ───────────────────────────────────────────────── -->
    <div class="space-y-3">
      <h4 class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">Groups</h4>

      <div class="flex flex-wrap gap-1.5">
        <Badge variant="secondary" v-for="g in memberGroups" :key="g.id">{{ g.name }}</Badge>
        <span v-if="memberGroups.length === 0" class="text-muted-foreground text-xs">No groups.</span>
      </div>
      <p class="text-xs text-muted-foreground">Group membership is managed from the Groups tab.</p>
    </div>

    <!-- ── Danger zone ─────────────────────────────────────────────────────── -->
    <div v-if="!isSelf" class="space-y-3 pt-2">
      <h4 class="text-2xs font-semibold uppercase tracking-caps text-destructive/70">Danger zone</h4>

      <div class="border border-destructive/20 rounded-xl p-4 bg-destructive/5">
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-foreground">Delete account</p>
            <p class="text-xs text-muted-foreground mt-0.5">Remove this user from HSI. Their Linux and Samba accounts stay on the server.</p>
          </div>

          <Button variant="destructive" size="sm"
            @click="deleteUser"
            :disabled="deleteBusy"
            class="shrink-0"
          >Delete</Button>
        </div>
        <p v-if="deleteError" role="alert" class="mt-2 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ deleteError }}</p>
      </div>
    </div>

  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 300ms; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
