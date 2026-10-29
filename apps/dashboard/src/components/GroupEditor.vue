<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { avatarGradient } from '../lib/avatar'
import { Button } from '@/components/ui/button'
import { ChevronLeftIcon, Trash2Icon } from '@lucide/vue'
import { ref, computed } from 'vue'
import { trpc } from '../lib/trpc'
import GroupPicker, { type PickerItem } from './ui/GroupPicker.vue'

const { t } = useI18n()

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
    if (ids.has(userId)) ids.delete(userId)
    else ids.add(userId)
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
      <Button variant="ghost" size="icon-sm"
        @click="$emit('back')"
        class="text-muted-foreground hover:text-foreground shrink-0"
        :tooltip="t('ui.settings.GroupEditor.backToGroups')" :aria-label="t('ui.settings.GroupEditor.backToGroups')"
      >
        <ChevronLeftIcon class="w-4 h-4" aria-hidden="true" />
      </Button>

      <!-- Name -->
      <div class="flex items-center gap-2 flex-1 min-w-0">
        <span class="text-base font-semibold text-foreground truncate">{{ group.name }}</span>
      </div>

      <!-- Delete -->
      <template v-if="!deleteConfirm">
        <Button variant="ghost" size="icon-sm"
          @click="deleteConfirm = true"
          class="text-muted-foreground hover:text-primary hover:bg-primary/10 shrink-0"
          :tooltip="t('ui.settings.GroupEditor.deleteGroup')" :aria-label="t('ui.settings.GroupEditor.deleteGroup')"
        >
          <Trash2Icon class="w-4 h-4" aria-hidden="true" />
        </Button>
      </template>
      <template v-else>
        <span class="text-xs text-destructive shrink-0">{{ t('ui.settings.GroupEditor.delete') }}</span>
        <Button variant="destructive" size="xs" :disabled="deleteBusy" @click="deleteGroup">{{ t('ui.settings.GroupEditor.yes') }}</Button>
        <Button variant="ghost" size="xs" @click="deleteConfirm = false">{{ t('ui.settings.GroupEditor.no') }}</Button>
      </template>
    </div>

    <p v-if="error" role="alert" class="px-0.5 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>

    <!-- ── Members ─────────────────────────────────────────────────────────── -->
    <div class="space-y-3">
      <div class="flex items-center justify-between px-0.5">
        <h4 class="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('ui.settings.GroupEditor.members') }}</h4>
        <span class="text-xs text-muted-foreground">{{ sortedUsers.filter(u => isMember(u)).length }} / {{ users.length }}</span>
      </div>

      <p v-if="users.length === 0" class="text-xs text-muted-foreground px-0.5">{{ t('ui.settings.GroupEditor.noUsers') }}</p>

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
