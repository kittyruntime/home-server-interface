<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import RoleEditor from './RoleEditor.vue'
import Pagination from './ui/Pagination.vue'
import SortableHeader from './ui/SortableHeader.vue'
import SearchInput from './ui/SearchInput.vue'
import { usePagination } from '../lib/usePagination'

type Role = {
  id: string
  name: string
  isAdmin: boolean
  createdAt: string
  userRoles: { userId: string }[]
  permissions: { permission: { name: string } }[]
}
type User = {
  id: string
  username: string
  displayName?: string | null
  userRoles: { role: { id: string } }[]
}

const roles        = ref<Role[]>([])
const users        = ref<User[]>([])
const selectedRole = ref<Role | null>(null)

const usernames  = computed(() => new Set(users.value.map(u => u.username)))
function isPersonal(role: Role) { return usernames.value.has(role.name) }

// ── Add role ─────────────────────────────────────────────────────────────────
const addingRole  = ref(false)
const newRoleName = ref('')
const createError = ref('')
const createLoading = ref(false)

function openAdd() {
  addingRole.value = true
  createError.value = ''
  newRoleName.value = ''
}
function cancelAdd() { addingRole.value = false }

// ── Search + sort ────────────────────────────────────────────────────────────
const search  = ref('')
type SortKey = 'name' | 'createdAt'
const sortKey = ref<SortKey>('createdAt')
const sortDir = ref<'asc' | 'desc'>('desc')

function toggleSort(key: SortKey) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortKey.value = key; sortDir.value = key === 'createdAt' ? 'desc' : 'asc' }
}

const filteredRoles = computed(() => {
  const q = search.value.trim().toLowerCase()
  const list = q ? roles.value.filter(r => r.name.toLowerCase().includes(q)) : roles.value
  return [...list].sort((a, b) => {
    const cmp = sortKey.value === 'name'
      ? a.name.localeCompare(b.name)
      : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    return sortDir.value === 'asc' ? cmp : -cmp
  })
})

// ── Pagination ──────────────────────────────────────────────────────────────
const { page, pageCount, paged, pageSize } = usePagination(filteredRoles, 10)

watch(search, () => { page.value = 1 })

function formatDate(d: string) {
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

async function load() {
  const [r, u] = await Promise.all([trpc.role.list.query(), trpc.user.list.query()])
  roles.value = r as Role[]
  users.value = u as User[]
  if (selectedRole.value) {
    selectedRole.value = roles.value.find(r => r.id === selectedRole.value!.id) ?? null
  }
}

async function createRole() {
  const name = newRoleName.value.trim()
  if (!name) return
  createError.value = ''
  createLoading.value = true
  try {
    await trpc.role.create.mutate({ name })
    addingRole.value = false
    await load()
    page.value = 1
    sortKey.value = 'createdAt'
    sortDir.value = 'desc'
  } catch (e: any) {
    createError.value = e?.message ?? 'Failed to create role'
  } finally {
    createLoading.value = false
  }
}

function openEditor(role: Role) { selectedRole.value = role }
function onBack() { selectedRole.value = null }

onMounted(load)
</script>

<template>
  <div>

    <!-- ── Role editor ───────────────────────────────────────────────────────── -->
    <RoleEditor
      v-if="selectedRole"
      :role="selectedRole"
      :users="users"
      @back="onBack"
      @reload="load"
    />

    <!-- ── Role list ─────────────────────────────────────────────────────────── -->
    <section v-else class="space-y-5">

      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-base font-semibold text-[var(--c-text-1)]">Roles</h2>
          <p class="text-xs text-[var(--c-text-3)] mt-0.5">
            {{ filteredRoles.length }} of {{ roles.length }} role{{ roles.length !== 1 ? 's' : '' }}
          </p>
        </div>
        <button
          v-if="!addingRole"
          @click="openAdd"
          class="btn btn-primary btn-xs shrink-0"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
          Add role
        </button>
      </div>

      <!-- Add role form -->
      <div v-if="addingRole" class="border border-[var(--c-border-strong)] bg-[var(--c-surface-alt)] rounded-xl p-4 space-y-3">
        <h4 class="text-[11px] font-semibold text-[var(--c-text-3)] uppercase tracking-widest">New role</h4>
        <div>
          <label class="block text-xs text-[var(--c-text-3)] mb-1">Name <span class="text-[var(--c-accent)]">*</span></label>
          <input
            v-model="newRoleName"
            placeholder="e.g. editor"
            autofocus
            @keydown.enter.prevent="createRole"
            class="ui-input"
          />
        </div>
        <p v-if="createError" class="text-[var(--c-accent)] text-xs">{{ createError }}</p>
        <div class="flex items-center gap-2 pt-1">
          <button
            @click="createRole"
            :disabled="createLoading || !newRoleName.trim()"
            class="btn btn-primary btn-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {{ createLoading ? 'Creating…' : 'Create' }}
          </button>
          <button @click="cancelAdd" class="btn btn-ghost btn-sm">Cancel</button>
        </div>
      </div>

      <!-- Search -->
      <SearchInput v-model="search" placeholder="Search roles by name…" class="max-w-sm" />

      <!-- Table -->
      <div class="panel-card">
        <table class="w-full text-sm">
          <thead>
            <tr class="bg-[var(--c-surface-alt)] border-b border-[var(--c-border)]">
              <th class="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">
                <SortableHeader :active="sortKey === 'name'" :dir="sortDir" @click="toggleSort('name')">Role</SortableHeader>
              </th>
              <th class="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)] hidden sm:table-cell">Members</th>
              <th class="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)] hidden sm:table-cell">Permissions</th>
              <th class="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)] hidden sm:table-cell">
                <SortableHeader :active="sortKey === 'createdAt'" :dir="sortDir" @click="toggleSort('createdAt')">Created</SortableHeader>
              </th>
              <th class="px-4 py-3 w-16"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--c-border)]">
            <tr
              v-for="role in paged"
              :key="role.id"
              class="bg-[var(--c-bg)] hover:bg-[var(--c-surface)] transition-colors"
            >
              <!-- Role -->
              <td class="px-5 py-3.5">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-medium text-[var(--c-text-1)]">{{ role.name }}</span>
                  <span v-if="role.isAdmin"
                    class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-[var(--c-accent-subtle)] text-[var(--c-accent)] shrink-0">
                    admin
                  </span>
                  <span v-if="isPersonal(role)"
                    class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium border border-[var(--c-border-strong)] text-[var(--c-text-3)] shrink-0">
                    personal
                  </span>
                </div>
              </td>

              <!-- Members -->
              <td class="px-5 py-3.5 hidden sm:table-cell text-[var(--c-text-3)] text-xs tabular-nums">
                {{ role.userRoles.length }}
              </td>

              <!-- Permissions -->
              <td class="px-5 py-3.5 hidden sm:table-cell text-[var(--c-text-3)] text-xs tabular-nums">
                {{ role.permissions.length }}
              </td>

              <!-- Created -->
              <td class="px-5 py-3.5 hidden sm:table-cell text-[var(--c-text-3)] text-xs tabular-nums">
                {{ formatDate(role.createdAt) }}
              </td>

              <!-- Actions -->
              <td class="px-4 py-3.5 text-right">
                <button
                  @click="openEditor(role)"
                  title="Edit role"
                  class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors"
                >
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                  </svg>
                </button>
              </td>
            </tr>

            <!-- Empty state -->
            <tr v-if="filteredRoles.length === 0">
              <td colspan="5" class="px-5 py-10 text-center text-sm text-[var(--c-text-3)] italic">
                {{ roles.length === 0 ? 'No roles yet.' : 'No roles match your search.' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <Pagination :page="page" :page-count="pageCount" :total="filteredRoles.length" :page-size="pageSize" @update:page="page = $event" />

    </section>
  </div>
</template>
