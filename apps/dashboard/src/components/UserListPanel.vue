<script setup lang="ts">
import UserAvatar from './UserAvatar.vue'
import { Card } from '@/components/ui/card'
import { PencilIcon, PlusIcon, TriangleAlertIcon } from '@lucide/vue'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDay } from '../lib/format-date'
import LoadingState from './ui/LoadingState.vue'
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import { applyPlanned } from '../lib/plan'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import UserDetailPanel from './UserDetailPanel.vue'
import Pagination from './ui/Pagination.vue'
import SortableHeader from './ui/SortableHeader.vue'
import SearchInput from './ui/SearchInput.vue'
import EmptyState from './ui/EmptyState.vue'
import { usePagination } from '../lib/usePagination'
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

const { isUserManager, currentUserId } = useAuth()
const toast = useToast()

const users     = ref<User[]>([])
const groups    = ref<Group[]>([])
const loading   = ref(true)
const loadError = ref('')

const selectedUser = ref<User | null>(null)

// ── Add user ─────────────────────────────────────────────────────────────────
const addingUser = ref(false)
const newUser    = reactive({ username: '', password: '', confirmPassword: '', displayName: '' })
// A username must be a valid Linux account name so it can back the user's
// Linux + Samba (SMB) account (enforced server-side by user.create too).
const usernameValid = computed(() => /^[a-z_][a-z0-9_-]{0,31}$/.test(newUser.username.trim()))
const addError   = ref('')
const addLoading = ref(false)

// ── Search + sort ────────────────────────────────────────────────────────────
const search  = ref('')
type SortKey = 'username' | 'createdAt'
const sortKey = ref<SortKey>('createdAt')
const sortDir = ref<'asc' | 'desc'>('desc')

function toggleSort(key: SortKey) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortKey.value = key; sortDir.value = key === 'createdAt' ? 'desc' : 'asc' }
}

const filteredUsers = computed(() => {
  const q = search.value.trim().toLowerCase()
  const list = q
    ? users.value.filter(u => u.username.toLowerCase().includes(q) || (u.displayName ?? '').toLowerCase().includes(q))
    : users.value
  return [...list].sort((a, b) => {
    const cmp = sortKey.value === 'username'
      ? a.username.localeCompare(b.username)
      : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    return sortDir.value === 'asc' ? cmp : -cmp
  })
})

// ── Pagination ────────────────────────────────────────────────────────────────
const { page, pageCount, paged, pageSize, clampPage } = usePagination(filteredUsers, 10)

watch(search, () => { page.value = 1 })

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const u = await trpc.user.list.query()
    users.value = u as User[]
    // group.list is admin-only server-side; a non-admin user-manager can still
    // manage users, just without the groups column: fail soft, not the whole panel.
    try {
      groups.value = await trpc.group.list.query() as Group[]
    } catch {
      groups.value = []
    }
    if (selectedUser.value) {
      selectedUser.value = users.value.find(u => u.id === selectedUser.value!.id) ?? null
    }
    clampPage()
  } catch {
    loadError.value = 'Failed to load users'
  } finally {
    loading.value = false
  }
}


// ── Add user ──────────────────────────────────────────────────────────────────
function openAdd() {
  addingUser.value = true
  addError.value = ''
  Object.assign(newUser, { username: '', password: '', confirmPassword: '', displayName: '' })
}
function cancelAdd() { addingUser.value = false }

async function submitAdd() {
  addError.value = ''
  if (newUser.password !== newUser.confirmPassword) { addError.value = 'Passwords do not match'; return }
  addLoading.value = true
  try {
    await applyPlanned('user.create', {
      username:    newUser.username.trim(),
      password:    newUser.password,
      displayName: newUser.displayName.trim() || undefined,
    }, { domain: 'users', title: `Create ${newUser.username.trim()}`, actionLabel: 'Create user' })
    addingUser.value = false
    toast.success(`User "${newUser.username.trim()}" created`)
    await load()
    page.value = pageCount.value
  } catch (e: any) {
    if (e?.message === '') return // cancelled in the plan dialog
    addError.value = e?.message ?? 'Failed to create user'
    toast.error(e?.message ?? 'Failed to create user')
  } finally {
    addLoading.value = false
  }
}

function openDetail(user: User) { selectedUser.value = user }
function onBack() { selectedUser.value = null }

onMounted(load)
</script>

<template>
  <div>

    <!-- ── Detail view ── -->
    <UserDetailPanel
      v-if="selectedUser"
      :user="selectedUser"
      :groups="groups"
      @back="onBack"
      @reload="load"
    />

    <!-- ── List view ── -->
    <div v-else class="space-y-6">

      <!-- Header -->
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-lg font-semibold text-foreground">Users</h2>
          <p v-if="!loading && !loadError" class="text-xs text-muted-foreground mt-0.5">
            {{ filteredUsers.length }} of {{ users.length }} account{{ users.length !== 1 ? 's' : '' }}
          </p>
        </div>
        <Button size="xs"
          v-if="isUserManager && !addingUser"
          @click="openAdd"
          class="shrink-0"
        >
          <PlusIcon class="w-3.5 h-3.5" aria-hidden="true" />
          Add user
        </Button>
      </div>

      <!-- Search -->
      <SearchInput v-if="!loading && !loadError" v-model="search" placeholder="Search by username or display name…" class="max-w-sm" />

      <!-- Add user form -->
      <div v-if="addingUser" class="border border-input bg-muted rounded-xl p-4 space-y-3">
        <h4 class="text-2xs font-semibold text-muted-foreground uppercase tracking-caps">New user</h4>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <div>
            <label class="block text-xs text-muted-foreground mb-1">Username <span class="text-primary">*</span></label>
            <Input v-model="newUser.username" placeholder="johndoe" autofocus/>
            <p class="text-2xs mt-1 leading-relaxed"
              :class="newUser.username && !usernameValid ? 'text-destructive' : 'text-muted-foreground'">
              Lowercase letters, digits, - or _ (start with a letter or _). Also used for the Linux / SMB account.
            </p>
          </div>
          <div>
            <label class="block text-xs text-muted-foreground mb-1">Display name</label>
            <Input v-model="newUser.displayName" placeholder="John Doe"/>
          </div>
          <div>
            <label class="block text-xs text-muted-foreground mb-1">Password <span class="text-primary">*</span></label>
            <Input v-model="newUser.password" type="password" placeholder="Min. 6 chars"/>
          </div>
          <div>
            <label class="block text-xs text-muted-foreground mb-1">Confirm password <span class="text-primary">*</span></label>
            <Input v-model="newUser.confirmPassword" type="password" placeholder="Repeat"/>
          </div>
        </div>

        <p v-if="addError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ addError }}</p>

        <div class="flex items-center gap-2 pt-1">
          <Button size="sm"
            @click="submitAdd"
            :disabled="addLoading || !usernameValid || !newUser.password"
            class="disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {{ addLoading ? 'Creating…' : 'Create' }}
          </Button>
          <Button variant="ghost" size="sm" @click="cancelAdd">Cancel</Button>
        </div>
      </div>

      <!-- Loading -->
      <LoadingState v-if="loading && !users.length" variant="block" />

      <!-- Error -->
      <div v-else-if="loadError" class="flex items-center gap-2 text-primary text-sm py-4">
        <TriangleAlertIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
        {{ loadError }}
      </div>

      <!-- Table -->
      <template v-else>
        <div class="space-y-2 sm:hidden"><article v-for="user in paged" :key="user.id" class="rounded-xl border border-border bg-card p-3" @click="isUserManager&&openDetail(user)"><div class="flex items-center gap-3"><UserAvatar :username="user.username" class="size-9 text-2xs" /><div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-1.5"><strong class="truncate text-sm text-foreground">{{user.username}}</strong><Badge v-if="user.isAdmin">admin</Badge><Badge variant="secondary" v-if="user.isUserManager">manager</Badge></div><p v-if="user.displayName" class="truncate text-xs text-muted-foreground">{{user.displayName}}</p></div><span v-if="isUserManager" aria-hidden="true" class="text-muted-foreground">›</span></div><div class="mt-2 flex flex-wrap gap-1"><Badge variant="secondary" v-for="g in groups.filter(g=>g.members.some(m=>m.userId===user.id))" :key="g.id">{{g.name}}</Badge></div></article><EmptyState v-if="filteredUsers.length===0" :message="users.length===0?'No users yet.':'No users match your search.'"><template v-if="users.length&&search" #action><Button variant="outline" size="sm" @click="search=''">Clear search</Button></template></EmptyState></div>
        <Card class="block gap-0 py-0 overflow-hidden hidden sm:block">
          <Table class="w-full text-sm">
            <TableHeader>
              <TableRow class="bg-muted border-b border-border">
                <TableHead class="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-caps text-muted-foreground">
                  <SortableHeader :active="sortKey === 'username'" :dir="sortDir" @click="toggleSort('username')">User</SortableHeader>
                </TableHead>
                <TableHead class="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-caps text-muted-foreground">Groups</TableHead>
                <TableHead class="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-caps text-muted-foreground hidden sm:table-cell">
                  <SortableHeader :active="sortKey === 'createdAt'" :dir="sortDir" @click="toggleSort('createdAt')">Created</SortableHeader>
                </TableHead>
                <TableHead v-if="isUserManager" class="px-4 py-3 w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody class="divide-y divide-border">
              <TableRow
                v-for="user in paged"
                :key="user.id"
                class="bg-background hover:bg-card transition-colors"
              >
                <!-- User -->
                <TableCell class="px-5 py-3.5">
                  <div class="flex items-center gap-3">
                    <UserAvatar :username="user.username" class="size-8 text-2xs" />
                    <div class="min-w-0">
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="font-medium text-foreground">{{ user.username }}</span>
                        <span v-if="user.id === currentUserId"
                          class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-2xs font-medium border border-input text-muted-foreground">you</span>
                        <span v-if="user.isAdmin"
                          class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-2xs font-medium bg-primary/10 text-primary">admin</span>
                        <Badge variant="secondary" v-if="user.isUserManager">manager</Badge>
                      </div>
                      <div v-if="user.displayName" class="text-xs text-muted-foreground truncate mt-0.5">{{ user.displayName }}</div>
                    </div>
                  </div>
                </TableCell>

                <!-- Groups -->
                <TableCell class="px-5 py-3.5">
                  <div class="flex flex-wrap gap-1">
                    <Badge variant="secondary" v-for="g in groups.filter(g => g.members.some(m => m.userId === user.id))" :key="g.id">
                      {{ g.name }}
                    </Badge>
                    <span v-if="!groups.some(g => g.members.some(m => m.userId === user.id))" class="text-muted-foreground text-xs">-</span>
                  </div>
                </TableCell>

                <!-- Created -->
                <TableCell class="px-5 py-3.5 hidden sm:table-cell text-muted-foreground text-xs tabular-nums">
                  {{ formatDay(user.createdAt) }}
                </TableCell>

                <!-- Actions -->
                <TableCell v-if="isUserManager" class="px-4 py-3.5 text-right">
                  <Button variant="ghost" size="icon-sm"
                    @click="openDetail(user)"
                    tooltip="Edit user" aria-label="Edit user"
                    class="text-muted-foreground hover:text-foreground"
                  >
                    <PencilIcon class="w-3.5 h-3.5" aria-hidden="true" />
                  </Button>
                </TableCell>
              </TableRow>

              <!-- Empty state -->
              <TableRow v-if="filteredUsers.length === 0">
                <TableCell :colspan="isUserManager ? 4 : 3" class="px-5 py-10 text-center text-sm text-muted-foreground">
                  <span>{{ users.length === 0 ? 'No users yet.' : 'No users match your search.' }}</span>
                  <Button variant="outline" size="xs" v-if="users.length && search" class="ml-2" @click="search = ''">Clear search</Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>

        <!-- Pagination -->
        <Pagination :page="page" :page-count="pageCount" :total="filteredUsers.length" :page-size="pageSize" @update:page="page = $event" />
      </template>

    </div>
  </div>
</template>
