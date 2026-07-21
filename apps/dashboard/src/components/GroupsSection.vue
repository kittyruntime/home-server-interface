<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import GroupEditor from './GroupEditor.vue'
import Pagination from './ui/Pagination.vue'
import SortableHeader from './ui/SortableHeader.vue'
import SearchInput from './ui/SearchInput.vue'
import { usePagination } from '../lib/usePagination'

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

const groups        = ref<Group[]>([])
const users         = ref<User[]>([])
const selectedGroup = ref<Group | null>(null)

// ── Add group ────────────────────────────────────────────────────────────────
const addingGroup  = ref(false)
const newGroupName = ref('')
const createError = ref('')
const createLoading = ref(false)

function openAdd() {
  addingGroup.value = true
  createError.value = ''
  newGroupName.value = ''
}
function cancelAdd() { addingGroup.value = false }

// ── Search + sort ────────────────────────────────────────────────────────────
const search  = ref('')
type SortKey = 'name' | 'createdAt'
const sortKey = ref<SortKey>('createdAt')
const sortDir = ref<'asc' | 'desc'>('desc')

function toggleSort(key: SortKey) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortKey.value = key; sortDir.value = key === 'createdAt' ? 'desc' : 'asc' }
}

const filteredGroups = computed(() => {
  const q = search.value.trim().toLowerCase()
  const list = q ? groups.value.filter(g => g.name.toLowerCase().includes(q)) : groups.value
  return [...list].sort((a, b) => {
    const cmp = sortKey.value === 'name'
      ? a.name.localeCompare(b.name)
      : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    return sortDir.value === 'asc' ? cmp : -cmp
  })
})

// ── Pagination ──────────────────────────────────────────────────────────────
const { page, pageCount, paged, pageSize } = usePagination(filteredGroups, 10)

watch(search, () => { page.value = 1 })

function formatDate(d: string) {
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

async function load() {
  const [g, u] = await Promise.all([trpc.group.list.query(), trpc.user.list.query()])
  groups.value = g as Group[]
  users.value = u as User[]
  if (selectedGroup.value) {
    selectedGroup.value = groups.value.find(g => g.id === selectedGroup.value!.id) ?? null
  }
}

async function createGroup() {
  const name = newGroupName.value.trim()
  if (!name) return
  createError.value = ''
  createLoading.value = true
  try {
    await trpc.group.create.mutate({ name })
    addingGroup.value = false
    await load()
    page.value = 1
    sortKey.value = 'createdAt'
    sortDir.value = 'desc'
  } catch (e: any) {
    createError.value = e?.message ?? 'Failed to create group'
  } finally {
    createLoading.value = false
  }
}

function openEditor(group: Group) { selectedGroup.value = group }
function onBack() { selectedGroup.value = null }

onMounted(load)
</script>

<template>
  <div>

    <!-- ── Group editor ──────────────────────────────────────────────────────── -->
    <GroupEditor
      v-if="selectedGroup"
      :group="selectedGroup"
      :users="users"
      @back="onBack"
      @reload="load"
    />

    <!-- ── Group list ────────────────────────────────────────────────────────── -->
    <section v-else class="space-y-5">

      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-base font-semibold text-[var(--c-text-1)]">Groups</h2>
          <p class="text-xs text-[var(--c-text-3)] mt-0.5">
            {{ filteredGroups.length }} of {{ groups.length }} group{{ groups.length !== 1 ? 's' : '' }}
          </p>
        </div>
        <button
          v-if="!addingGroup"
          @click="openAdd"
          class="btn btn-primary btn-xs shrink-0"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
          Add group
        </button>
      </div>

      <!-- Add group form -->
      <div v-if="addingGroup" class="border border-[var(--c-border-strong)] bg-[var(--c-surface-alt)] rounded-xl p-4 space-y-3">
        <h4 class="text-[11px] font-semibold text-[var(--c-text-3)] uppercase tracking-widest">New group</h4>
        <div>
          <label class="block text-xs text-[var(--c-text-3)] mb-1">Name <span class="text-[var(--c-accent)]">*</span></label>
          <input
            v-model="newGroupName"
            placeholder="e.g. editors"
            autofocus
            @keydown.enter.prevent="createGroup"
            class="ui-input"
          />
        </div>
        <p v-if="createError" class="text-[var(--c-accent)] text-xs">{{ createError }}</p>
        <div class="flex items-center gap-2 pt-1">
          <button
            @click="createGroup"
            :disabled="createLoading || !newGroupName.trim()"
            class="btn btn-primary btn-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {{ createLoading ? 'Creating…' : 'Create' }}
          </button>
          <button @click="cancelAdd" class="btn btn-ghost btn-sm">Cancel</button>
        </div>
      </div>

      <!-- Search -->
      <SearchInput v-model="search" placeholder="Search groups by name…" class="max-w-sm" />

      <!-- Table -->
      <div class="panel-card">
        <table class="w-full text-sm">
          <thead>
            <tr class="bg-[var(--c-surface-alt)] border-b border-[var(--c-border)]">
              <th class="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)]">
                <SortableHeader :active="sortKey === 'name'" :dir="sortDir" @click="toggleSort('name')">Group</SortableHeader>
              </th>
              <th class="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)] hidden sm:table-cell">Members</th>
              <th class="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-widest text-[var(--c-text-3)] hidden sm:table-cell">
                <SortableHeader :active="sortKey === 'createdAt'" :dir="sortDir" @click="toggleSort('createdAt')">Created</SortableHeader>
              </th>
              <th class="px-4 py-3 w-16"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--c-border)]">
            <tr
              v-for="group in paged"
              :key="group.id"
              class="bg-[var(--c-bg)] hover:bg-[var(--c-surface)] transition-colors"
            >
              <!-- Group -->
              <td class="px-5 py-3.5">
                <span class="font-medium text-[var(--c-text-1)]">{{ group.name }}</span>
              </td>

              <!-- Members -->
              <td class="px-5 py-3.5 hidden sm:table-cell text-[var(--c-text-3)] text-xs tabular-nums">
                {{ group.members.length }}
              </td>

              <!-- Created -->
              <td class="px-5 py-3.5 hidden sm:table-cell text-[var(--c-text-3)] text-xs tabular-nums">
                {{ formatDate(group.createdAt) }}
              </td>

              <!-- Actions -->
              <td class="px-4 py-3.5 text-right">
                <button
                  @click="openEditor(group)"
                  title="Edit group"
                  class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors"
                >
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                  </svg>
                </button>
              </td>
            </tr>

            <!-- Empty state -->
            <tr v-if="filteredGroups.length === 0">
              <td colspan="4" class="px-5 py-10 text-center text-sm text-[var(--c-text-3)] italic">
                {{ groups.length === 0 ? 'No groups yet.' : 'No groups match your search.' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <Pagination :page="page" :page-count="pageCount" :total="filteredGroups.length" :page-size="pageSize" @update:page="page = $event" />

    </section>
  </div>
</template>
