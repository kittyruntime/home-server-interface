<script setup lang="ts">
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDay } from '../lib/format-date'
import { ref, computed, watch, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import GroupEditor from './GroupEditor.vue'
import Pagination from './ui/Pagination.vue'
import SortableHeader from './ui/SortableHeader.vue'
import SearchInput from './ui/SearchInput.vue'
import { usePagination } from '../lib/usePagination'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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
          <h2 class="text-lg font-semibold text-foreground">Groups</h2>
          <p class="text-xs text-muted-foreground mt-0.5">
            {{ filteredGroups.length }} of {{ groups.length }} group{{ groups.length !== 1 ? 's' : '' }}
          </p>
        </div>
        <Button size="xs"
          v-if="!addingGroup"
          @click="openAdd"
          class="shrink-0"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
          Add group
        </Button>
      </div>

      <!-- Add group form -->
      <div v-if="addingGroup" class="border border-input bg-muted rounded-xl p-4 space-y-3">
        <h4 class="text-2xs font-semibold text-muted-foreground uppercase tracking-caps">New group</h4>
        <div>
          <label class="block text-xs text-muted-foreground mb-1">Name <span class="text-primary">*</span></label>
          <Input
            v-model="newGroupName"
            placeholder="e.g. editors"
            autofocus
            @keydown.enter.prevent="createGroup"
          />
        </div>
        <p v-if="createError" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ createError }}</p>
        <div class="flex items-center gap-2 pt-1">
          <Button size="sm"
            @click="createGroup"
            :disabled="createLoading || !newGroupName.trim()"
            class="disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {{ createLoading ? 'Creating…' : 'Create' }}
          </Button>
          <Button variant="ghost" size="sm" @click="cancelAdd">Cancel</Button>
        </div>
      </div>

      <!-- Search -->
      <SearchInput v-model="search" placeholder="Search groups by name…" class="max-w-sm" />

      <!-- Table -->
      <div class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden">
        <Table class="w-full text-sm">
          <TableHeader>
            <TableRow class="bg-muted border-b border-border">
              <TableHead class="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-caps text-muted-foreground">
                <SortableHeader :active="sortKey === 'name'" :dir="sortDir" @click="toggleSort('name')">Group</SortableHeader>
              </TableHead>
              <TableHead class="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-caps text-muted-foreground hidden sm:table-cell">Members</TableHead>
              <TableHead class="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-caps text-muted-foreground hidden sm:table-cell">
                <SortableHeader :active="sortKey === 'createdAt'" :dir="sortDir" @click="toggleSort('createdAt')">Created</SortableHeader>
              </TableHead>
              <TableHead class="px-4 py-3 w-16"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody class="divide-y divide-border">
            <TableRow
              v-for="group in paged"
              :key="group.id"
              class="bg-background hover:bg-card transition-colors"
            >
              <!-- Group -->
              <TableCell class="px-5 py-3.5">
                <span class="font-medium text-foreground">{{ group.name }}</span>
              </TableCell>

              <!-- Members -->
              <TableCell class="px-5 py-3.5 hidden sm:table-cell text-muted-foreground text-xs tabular-nums">
                {{ group.members.length }}
              </TableCell>

              <!-- Created -->
              <TableCell class="px-5 py-3.5 hidden sm:table-cell text-muted-foreground text-xs tabular-nums">
                {{ formatDay(group.createdAt) }}
              </TableCell>

              <!-- Actions -->
              <TableCell class="px-4 py-3.5 text-right">
                <button
                  @click="openEditor(group)"
                  title="Edit group"
                  class="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                  </svg>
                </button>
              </TableCell>
            </TableRow>

            <!-- Empty state -->
            <TableRow v-if="filteredGroups.length === 0">
              <TableCell colspan="4" class="px-5 py-10 text-center text-sm text-muted-foreground">
                <span>{{ groups.length === 0 ? 'No groups yet.' : 'No groups match your search.' }}</span>
                <Button variant="outline" size="xs" v-if="groups.length && search" class="ml-2" @click="search = ''">Clear search</Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <!-- Pagination -->
      <Pagination :page="page" :page-count="pageCount" :total="filteredGroups.length" :page-size="pageSize" @update:page="page = $event" />

    </section>
  </div>
</template>
