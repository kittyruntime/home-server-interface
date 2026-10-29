<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Card } from '@/components/ui/card'
import { PencilIcon, PlusIcon } from '@lucide/vue'
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
    createError.value = e?.message ?? t('uis.settings.GroupsSection.failedToCreateGroup')
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
          <h2 class="text-lg font-semibold text-foreground">{{ t('ui.settings.GroupsSection.groups') }}</h2>
          <p class="text-xs text-muted-foreground mt-0.5">
            {{ t('uip.settings.GroupsSection.ofGroup', { p0: filteredGroups.length, p1: groups.length, p2: groups.length !== 1 ? 's' : '' }) }}
          </p>
        </div>
        <Button size="xs"
          v-if="!addingGroup"
          @click="openAdd"
          class="shrink-0"
        >
          <PlusIcon class="w-3.5 h-3.5" aria-hidden="true" />
          {{ t('ui.settings.GroupsSection.addGroup') }}
        </Button>
      </div>

      <!-- Add group form -->
      <div v-if="addingGroup" class="border border-input bg-muted rounded-xl p-4 space-y-3">
        <h4 class="text-2xs font-semibold text-muted-foreground uppercase tracking-caps">{{ t('ui.settings.GroupsSection.newGroup') }}</h4>
        <div>
          <label class="block text-xs text-muted-foreground mb-1">{{ t('ui.settings.GroupsSection.name') }} <span class="text-primary">*</span></label>
          <Input
            v-model="newGroupName"
            :placeholder="t('ui.settings.GroupsSection.eGEditors')"
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
          <Button variant="ghost" size="sm" @click="cancelAdd">{{ t('ui.settings.GroupsSection.cancel') }}</Button>
        </div>
      </div>

      <!-- Search -->
      <SearchInput v-model="search" :placeholder="t('ui.settings.GroupsSection.searchGroupsByName')" class="max-w-sm" />

      <!-- Table -->
      <Card class="block gap-0 py-0 overflow-hidden">
        <Table class="w-full text-sm">
          <TableHeader>
            <TableRow class="bg-muted border-b border-border">
              <TableHead class="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-caps text-muted-foreground">
                <SortableHeader :active="sortKey === 'name'" :dir="sortDir" @click="toggleSort('name')">{{ t('ui.settings.GroupsSection.group') }}</SortableHeader>
              </TableHead>
              <TableHead class="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-caps text-muted-foreground hidden sm:table-cell">{{ t('ui.settings.GroupsSection.members') }}</TableHead>
              <TableHead class="px-5 py-3 text-left text-2xs font-semibold uppercase tracking-caps text-muted-foreground hidden sm:table-cell">
                <SortableHeader :active="sortKey === 'createdAt'" :dir="sortDir" @click="toggleSort('createdAt')">{{ t('ui.settings.GroupsSection.created') }}</SortableHeader>
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
                <Button variant="ghost" size="icon-sm"
                  @click="openEditor(group)"
                  :tooltip="t('ui.settings.GroupsSection.editGroup')" :aria-label="t('ui.settings.GroupsSection.editGroup')"
                  class="text-muted-foreground hover:text-foreground"
                >
                  <PencilIcon class="w-3.5 h-3.5" aria-hidden="true" />
                </Button>
              </TableCell>
            </TableRow>

            <!-- Empty state -->
            <TableRow v-if="filteredGroups.length === 0">
              <TableCell colspan="4" class="px-5 py-10 text-center text-sm text-muted-foreground">
                <span>{{ groups.length === 0 ? 'No groups yet.' : 'No groups match your search.' }}</span>
                <Button variant="outline" size="xs" v-if="groups.length && search" class="ml-2" @click="search = ''">{{ t('ui.settings.GroupsSection.clearSearch') }}</Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>

      <!-- Pagination -->
      <Pagination :page="page" :page-count="pageCount" :total="filteredGroups.length" :page-size="pageSize" @update:page="page = $event" />

    </section>
  </div>
</template>
