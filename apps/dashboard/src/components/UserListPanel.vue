<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import UserDetailPanel from './UserDetailPanel.vue'
import Pagination from './ui/Pagination.vue'
import LoadingSpinner from './ui/LoadingSpinner.vue'
import SortableHeader from './ui/SortableHeader.vue'
import SearchInput from './ui/SearchInput.vue'
import { usePagination } from '../lib/usePagination'

type User = {
  id: string
  username: string
  displayName: string | null
  isAdmin: boolean
  isUserManager: boolean
  createdAt: Date | string
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
    // manage users, just without the groups column — fail soft, not the whole panel.
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

function formatDate(d: Date | string) {
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
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
    await trpc.user.create.mutate({
      username:    newUser.username.trim(),
      password:    newUser.password,
      displayName: newUser.displayName.trim() || undefined,
    })
    addingUser.value = false
    toast.success(`User "${newUser.username.trim()}" created`)
    await load()
    page.value = pageCount.value
  } catch (e: any) {
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
          <h2 class="text-base font-semibold text-[var(--c-text-1)]">Users</h2>
          <p v-if="!loading && !loadError" class="text-xs text-[var(--c-text-3)] mt-0.5">
            {{ filteredUsers.length }} of {{ users.length }} account{{ users.length !== 1 ? 's' : '' }}
          </p>
        </div>
        <button
          v-if="isUserManager && !addingUser"
          @click="openAdd"
          class="btn btn-primary btn-xs shrink-0"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
          Add user
        </button>
      </div>

      <!-- Search -->
      <SearchInput v-if="!loading && !loadError" v-model="search" placeholder="Search by username or display name…" class="max-w-sm" />

      <!-- Add user form -->
      <div v-if="addingUser" class="border border-[var(--c-border-strong)] bg-[var(--c-surface-alt)] rounded-xl p-4 space-y-3">
        <h4 class="text-[11px] font-semibold text-[var(--c-text-3)] uppercase tracking-widest">New user</h4>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <div>
            <label class="block text-xs text-[var(--c-text-3)] mb-1">Username <span class="text-[var(--c-accent)]">*</span></label>
            <input v-model="newUser.username" placeholder="johndoe" autofocus class="ui-input"/>
            <p class="text-[11px] mt-1 leading-relaxed"
              :class="newUser.username && !usernameValid ? 'text-[var(--c-danger)]' : 'text-[var(--c-text-3)]'">
              Lowercase letters, digits, - or _ (start with a letter or _). Also used for the Linux / SMB account.
            </p>
          </div>
          <div>
            <label class="block text-xs text-[var(--c-text-3)] mb-1">Display name</label>
            <input v-model="newUser.displayName" placeholder="John Doe" class="ui-input"/>
          </div>
          <div>
            <label class="block text-xs text-[var(--c-text-3)] mb-1">Password <span class="text-[var(--c-accent)]">*</span></label>
            <input v-model="newUser.password" type="password" placeholder="Min. 6 chars" class="ui-input"/>
          </div>
          <div>
            <label class="block text-xs text-[var(--c-text-3)] mb-1">Confirm password <span class="text-[var(--c-accent)]">*</span></label>
            <input v-model="newUser.confirmPassword" type="password" placeholder="Repeat" class="ui-input"/>
          </div>
        </div>

        <p v-if="addError" class="text-[var(--c-accent)] text-xs">{{ addError }}</p>

        <div class="flex items-center gap-2 pt-1">
          <button
            @click="submitAdd"
            :disabled="addLoading || !usernameValid || !newUser.password"
            class="btn btn-primary btn-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {{ addLoading ? 'Creating…' : 'Create' }}
          </button>
          <button @click="cancelAdd" class="btn btn-ghost btn-sm">Cancel</button>
        </div>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="flex items-center text-[var(--c-text-3)] text-sm py-6">
        <LoadingSpinner />
      </div>

      <!-- Error -->
      <div v-else-if="loadError" class="flex items-center gap-2 text-[var(--c-accent)] text-sm py-4">
        <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        </svg>
        {{ loadError }}
      </div>

      <!-- Table -->
      <template v-else>
        <div class="panel-card">
          <table class="w-full text-sm">
            <thead>
              <tr class="bg-[var(--c-surface-alt)] border-b border-[var(--c-border)]">
                <th class="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">
                  <SortableHeader :active="sortKey === 'username'" :dir="sortDir" @click="toggleSort('username')">User</SortableHeader>
                </th>
                <th class="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Groups</th>
                <th class="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)] hidden sm:table-cell">
                  <SortableHeader :active="sortKey === 'createdAt'" :dir="sortDir" @click="toggleSort('createdAt')">Created</SortableHeader>
                </th>
                <th v-if="isUserManager" class="px-4 py-3 w-16"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[var(--c-border)]">
              <tr
                v-for="user in paged"
                :key="user.id"
                class="bg-[var(--c-bg)] hover:bg-[var(--c-surface)] transition-colors"
              >
                <!-- User -->
                <td class="px-5 py-3.5">
                  <div class="flex items-center gap-3">
                    <div :class="['w-8 h-8 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-[11px] font-bold shrink-0', avatarGradient(user.username)]">
                      {{ user.username.slice(0, 2).toUpperCase() }}
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="font-medium text-[var(--c-text-1)]">{{ user.username }}</span>
                        <span v-if="user.id === currentUserId"
                          class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium border border-[var(--c-border-strong)] text-[var(--c-text-3)]">you</span>
                        <span v-if="user.isAdmin"
                          class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-[var(--c-accent-subtle)] text-[var(--c-accent)]">admin</span>
                        <span v-if="user.isUserManager" class="badge badge-violet">manager</span>
                      </div>
                      <div v-if="user.displayName" class="text-xs text-[var(--c-text-3)] truncate mt-0.5">{{ user.displayName }}</div>
                    </div>
                  </div>
                </td>

                <!-- Groups -->
                <td class="px-5 py-3.5">
                  <div class="flex flex-wrap gap-1">
                    <span v-for="g in groups.filter(g => g.members.some(m => m.userId === user.id))" :key="g.id"
                      class="badge badge-violet">
                      {{ g.name }}
                    </span>
                    <span v-if="!groups.some(g => g.members.some(m => m.userId === user.id))" class="text-[var(--c-text-3)] text-xs">—</span>
                  </div>
                </td>

                <!-- Created -->
                <td class="px-5 py-3.5 hidden sm:table-cell text-[var(--c-text-3)] text-xs tabular-nums">
                  {{ formatDate(user.createdAt) }}
                </td>

                <!-- Actions -->
                <td v-if="isUserManager" class="px-4 py-3.5 text-right">
                  <button
                    @click="openDetail(user)"
                    title="Edit user"
                    class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                    </svg>
                  </button>
                </td>
              </tr>

              <!-- Empty state -->
              <tr v-if="filteredUsers.length === 0">
                <td :colspan="isUserManager ? 4 : 3" class="px-5 py-10 text-center text-sm text-[var(--c-text-3)] italic">
                  {{ users.length === 0 ? 'No users yet.' : 'No users match your search.' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Pagination -->
        <Pagination :page="page" :page-count="pageCount" :total="filteredUsers.length" :page-size="pageSize" @update:page="page = $event" />
      </template>

    </div>
  </div>
</template>
