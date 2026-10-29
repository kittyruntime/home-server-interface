<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import UserAvatar from './UserAvatar.vue'
import { Alert } from '@/components/ui/alert'
import { Card } from '@/components/ui/card'
import { CheckIcon, ChevronLeftIcon } from '@lucide/vue'
import { Checkbox } from '@/components/ui/checkbox'
import LoadingState from './ui/LoadingState.vue'
import { ref, reactive, computed, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import { applyPlanned } from '../lib/plan'
import { useAuth } from '../lib/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

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
    identityError.value = e?.message ?? t('uis.settings.UserDetailPanel.failedToLoadIdentityStatus')
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
    identityError.value = e?.message ?? t('uis.settings.UserDetailPanel.failedToUpdate')
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
    saveError.value = e?.message ?? t('uis.settings.UserDetailPanel.failedToSave')
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
    accountError.value = e?.message ?? t('uis.settings.UserDetailPanel.failedToUpdate')
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
    capabilityError.value = e?.message ?? t('uis.settings.UserDetailPanel.failedToUpdate')
  } finally {
    capabilityBusy.value[capability] = false
  }
}

async function deleteUser() {
  deleteBusy.value = true
  deleteError.value = ''
  try {
    await applyPlanned('user.delete', { userId: props.user.id }, {
      domain: 'users', title: t('uis.settings.UserDetailPanel.delete', { p0: props.user.username }), actionLabel: t('uis.settings.UserDetailPanel.deleteUser'), danger: true,
    })
    emit('back')
  } catch (e: any) {
    if (e?.message === '') return // cancelled in the plan dialog
    deleteError.value = e?.message ?? t('uis.settings.UserDetailPanel.failedToDeleteUser')
  } finally {
    deleteBusy.value = false
  }
}
</script>

<template>
  <div class="space-y-8">

    <!-- ── Header ─────────────────────────────────────────────────────────── -->
    <div class="flex items-center gap-3">
      <Button variant="ghost" size="icon-sm"
        @click="$emit('back')"
        class="text-muted-foreground hover:text-foreground shrink-0"
        :tooltip="t('ui.settings.UserDetailPanel.backToUsers')" :aria-label="t('ui.settings.UserDetailPanel.backToUsers')"
      >
        <ChevronLeftIcon class="w-4 h-4" aria-hidden="true" />
      </Button>

      <UserAvatar :username="user.username" class="size-9 text-xs" />

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
      <h4 class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.settings.UserDetailPanel.profile') }}</h4>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div class="space-y-1.5">
          <label class="block text-xs text-muted-foreground">{{ t('ui.settings.UserDetailPanel.displayName') }}</label>
          <Input
            v-model="form.displayName"
            :placeholder="t('ui.settings.UserDetailPanel.fullName')"
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
            <CheckIcon class="w-3.5 h-3.5" aria-hidden="true" />
            {{ t('ui.settings.UserDetailPanel.saved') }}
          </span>
        </transition>
      </div>
    </div>

    <!-- ── Account (admin only) ──────────────────────────────────────────────── -->
    <div v-if="isAdmin" class="space-y-3">
      <h4 class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.settings.UserDetailPanel.account') }}</h4>

      <Card class="block gap-0 py-0 shadow-none divide-y divide-border">
        <label class="flex items-center justify-between gap-4 px-4 py-3 cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': isSelf }">
          <div>
            <p class="text-sm text-foreground">{{ t('ui.settings.UserDetailPanel.admin') }}</p>
            <p class="text-xs text-muted-foreground mt-0.5">{{ t('ui.settings.UserDetailPanel.fullAccessToEveryPlace') }}</p>
          </div>
          <Checkbox :model-value="user.isAdmin" :disabled="isSelf || accountBusy.isAdmin" @update:model-value="toggleAccountFlag('isAdmin')" class="shrink-0" />
        </label>
        <label class="flex items-center justify-between gap-4 px-4 py-3 cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': isSelf }">
          <div>
            <p class="text-sm text-foreground">{{ t('ui.settings.UserDetailPanel.userManager') }}</p>
            <p class="text-xs text-muted-foreground mt-0.5">{{ t('ui.settings.UserDetailPanel.canCreateEditAndDelete') }}</p>
          </div>
          <Checkbox :model-value="user.isUserManager" :disabled="isSelf || accountBusy.isUserManager" @update:model-value="toggleAccountFlag('isUserManager')" class="shrink-0" />
        </label>
        <label class="flex items-center justify-between gap-4 px-4 py-3 cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': isSelf }">
          <div>
            <p class="text-sm text-foreground">{{ t('ui.settings.UserDetailPanel.storageAdmin') }}</p>
            <p class="text-xs text-muted-foreground mt-0.5">{{ t('ui.settings.UserDetailPanel.canManageDisksRaidLvm') }}</p>
          </div>
          <Checkbox :model-value="userHasCapability('storage')" :disabled="isSelf || capabilityBusy.storage" @update:model-value="toggleCapability('storage')" class="shrink-0" />
        </label>
      </Card>

      <p class="text-xs text-muted-foreground px-0.5">{{ t('ui.settings.UserDetailPanel.accessChangesApplyImmediatelyBut') }}</p>
      <p v-if="isSelf" class="text-xs text-muted-foreground px-0.5">{{ t('ui.settings.UserDetailPanel.youCanTChangeYour') }}</p>
      <p v-if="accountError" role="alert" class="px-0.5 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ accountError }}</p>
      <p v-if="capabilityError" role="alert" class="px-0.5 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ capabilityError }}</p>
    </div>

    <!-- ── Identity (Linux + Samba, as the OS actually sees it) ─────────────── -->
    <div v-if="isAdmin" class="space-y-3">
      <h4 class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.settings.UserDetailPanel.identity') }}</h4>

      <LoadingState v-if="identityLoading" variant="inline" class="text-xs" />
      <p v-else-if="identityError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ identityError }}</p>

      <Card v-else-if="identity" class="block gap-0 py-0 shadow-none divide-y divide-border">
        <!-- HSI identity -->
        <div class="flex items-center justify-between gap-4 px-4 py-3">
          <p class="text-sm text-foreground">{{ t('ui.settings.UserDetailPanel.hsiIdentity') }}</p>
          <span class="text-xs font-mono text-foreground/80">{{ user.username }}</span>
        </div>

        <!-- Linux identity -->
        <div class="flex items-start justify-between gap-4 px-4 py-3">
          <div>
            <p class="text-sm text-foreground">{{ t('ui.settings.UserDetailPanel.linuxIdentity') }}</p>
            <p class="text-xs text-muted-foreground mt-0.5">{{ t('ui.settings.UserDetailPanel.backsFilesystemOwnershipForThis') }}</p>
          </div>
          <div class="text-right shrink-0">
            <template v-if="identity.linuxExists">
              <div class="text-xs font-mono text-foreground/80">{{ t('uip.settings.UserDetailPanel.uidGid', { p0: identity.uid, p1: identity.gid }) }}</div>
              <div v-if="identity.groups?.length" class="text-2xs text-muted-foreground mt-0.5">{{ identity.groups.join(', ') }}</div>
            </template>
            <span v-else class="text-xs text-destructive">{{ t('ui.settings.UserDetailPanel.missing') }}</span>
          </div>
        </div>

        <!-- Samba identity -->
        <label class="flex items-center justify-between gap-4 px-4 py-3 cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': isSelf }">
          <div>
            <p class="text-sm text-foreground">{{ t('ui.settings.UserDetailPanel.sambaIdentity') }}</p>
            <p class="text-xs text-muted-foreground mt-0.5">
              {{ t('ui.settings.UserDetailPanel.whetherThisAccountShouldBe') }}
              <span v-if="identity.sambaExists" class="text-success">{{ t('ui.settings.UserDetailPanel.accountExists') }}</span>
              <span v-else class="text-muted-foreground">{{ t('ui.settings.UserDetailPanel.noAccountOnTheSystem') }}</span>
            </p>
          </div>
          <Checkbox :model-value="identity.sambaEnabled" :disabled="isSelf || sambaBusy" @update:model-value="toggleSamba" class="shrink-0" />
        </label>
      </Card>

      <p v-if="identity?.issue" class="text-xs text-warning px-0.5">{{ identity.issue }}</p>
    </div>

    <!-- ── Groups (read-only) ───────────────────────────────────────────────── -->
    <div class="space-y-3">
      <h4 class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.settings.UserDetailPanel.groups') }}</h4>

      <div class="flex flex-wrap gap-1.5">
        <Badge variant="secondary" v-for="g in memberGroups" :key="g.id">{{ g.name }}</Badge>
        <span v-if="memberGroups.length === 0" class="text-muted-foreground text-xs">{{ t('ui.settings.UserDetailPanel.noGroups') }}</span>
      </div>
      <p class="text-xs text-muted-foreground">{{ t('ui.settings.UserDetailPanel.groupMembershipIsManagedFrom') }}</p>
    </div>

    <!-- ── Danger zone ─────────────────────────────────────────────────────── -->
    <div v-if="!isSelf" class="space-y-3 pt-2">
      <h4 class="text-2xs font-semibold uppercase tracking-caps text-destructive/70">{{ t('ui.settings.UserDetailPanel.dangerZone') }}</h4>

      <Alert variant="destructive" class="block p-4 text-foreground" role="note">
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-foreground">{{ t('ui.settings.UserDetailPanel.deleteAccount') }}</p>
            <p class="text-xs text-muted-foreground mt-0.5">{{ t('ui.settings.UserDetailPanel.removeThisUserFromHsi') }}</p>
          </div>

          <Button variant="destructive" size="sm"
            @click="deleteUser"
            :disabled="deleteBusy"
            class="shrink-0"
          >{{ t('ui.settings.UserDetailPanel.delete') }}</Button>
        </div>
        <p v-if="deleteError" role="alert" class="mt-2 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ deleteError }}</p>
      </Alert>
    </div>

  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 300ms; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
