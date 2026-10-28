<script setup lang="ts">
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import { ref, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import { Badge } from '@/components/ui/badge'

type Place = { id: string; name: string; path: string }
type Group = { id: string; name: string }
type User = { id: string; username: string; isAdmin: boolean }
type Perm = { id: string; placeId: string; subjectType: string; subjectId: string; canRead: boolean; canWrite: boolean; canDelete: boolean; canShare: boolean }

const places = ref<Place[]>([])
const groups = ref<Group[]>([])
const users = ref<User[]>([])
const permsByPlace = ref<Record<string, Perm[]>>({})
const expandedPlace = ref<string | null>(null)

async function load() {
  const [p, g, u] = await Promise.all([
    trpc.place.list.query(),
    trpc.group.list.query(),
    trpc.user.list.query(),
  ])
  places.value = p as Place[]
  groups.value = g as Group[]
  users.value = u as User[]
}

async function loadPerms(placeId: string) {
  const perms = await trpc.permission.listForPlace.query({ placeId })
  permsByPlace.value[placeId] = perms as Perm[]
}

async function togglePlace(placeId: string) {
  if (expandedPlace.value === placeId) {
    expandedPlace.value = null
    return
  }
  expandedPlace.value = placeId
  await loadPerms(placeId)
}

function getPerm(placeId: string, subjectType: string, subjectId: string): Perm | undefined {
  return permsByPlace.value[placeId]?.find(
    p => p.subjectType === subjectType && p.subjectId === subjectId
  )
}

async function togglePerm(
  placeId: string,
  subjectType: 'user' | 'group',
  subjectId: string,
  field: 'canRead' | 'canWrite' | 'canDelete' | 'canShare',
) {
  const current = getPerm(placeId, subjectType, subjectId)
  const next = {
    canRead: current?.canRead ?? false,
    canWrite: current?.canWrite ?? false,
    canDelete: current?.canDelete ?? false,
    canShare: current?.canShare ?? false,
  }
  next[field] = !next[field]

  // If all are false, remove the record
  if (!next.canRead && !next.canWrite && !next.canDelete && !next.canShare) {
    await trpc.permission.remove.mutate({ placeId, subjectType, subjectId })
  } else {
    await trpc.permission.upsert.mutate({ placeId, subjectType, subjectId, ...next })
  }
  await loadPerms(placeId)
}

onMounted(load)
</script>

<template>
  <section>
    <h3 class="text-xs font-medium uppercase tracking-caps text-muted-foreground mb-3 px-1">Permissions</h3>

    <div v-if="places.length === 0" class="text-sm text-muted-foreground px-1">No places yet. Add one in the Places tab, then grant users or groups access here.</div>

    <div class="space-y-2">
      <div
        v-for="place in places"
        :key="place.id"
        class="bg-card border border-border rounded-xl overflow-hidden"
      >
        <!-- Place header (accordion) -->
        <button
          @click="togglePlace(place.id)"
          class="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-accent transition-colors"
        >
          <div>
            <span class="text-sm font-medium text-foreground">{{ place.name }}</span>
            <span class="ml-2 text-xs text-muted-foreground font-mono">{{ place.path }}</span>
          </div>
          <svg
            :class="['w-3.5 h-3.5 text-muted-foreground transition-transform', expandedPlace === place.id ? 'rotate-180' : '']"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
          </svg>
        </button>

        <!-- Permission matrix -->
        <div v-if="expandedPlace === place.id" class="border-t border-border">
          <p class="px-4 py-1.5 text-2xs text-muted-foreground leading-relaxed">Admins always have full access.</p>
          <Table class="w-full text-xs">
            <TableHeader>
              <TableRow class="text-muted-foreground uppercase tracking-caps border-b border-border">
                <TableHead class="px-4 py-2 text-left font-medium">Subject</TableHead>
                <TableHead class="px-3 py-2 text-center font-medium w-16">Read</TableHead>
                <TableHead class="px-3 py-2 text-center font-medium w-16">Write</TableHead>
                <TableHead class="px-3 py-2 text-center font-medium w-16">Delete</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody class="divide-y divide-border">
              <!-- Groups -->
              <TableRow v-for="group in groups" :key="'group-' + group.id">
                <TableCell class="px-4 py-2.5">
                  <div class="flex items-center gap-1.5">
                    <Badge variant="secondary">group</Badge>
                    <span class="text-foreground/80">{{ group.name }}</span>
                  </div>
                </TableCell>
                <TableCell v-for="field in (['canRead', 'canWrite', 'canDelete'] as const)" :key="field" class="px-3 py-2.5 text-center">
                  <Checkbox :model-value="getPerm(place.id, 'group', group.id)?.[field] ?? false" @update:model-value="togglePerm(place.id, 'group', group.id, field)" />
                </TableCell>
              </TableRow>

              <!-- Users (admins always have full access) -->
              <TableRow v-for="user in users" :key="'user-' + user.id">
                <TableCell class="px-4 py-2.5">
                  <div class="flex items-center gap-1.5">
                    <span class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-2xs font-medium bg-muted text-muted-foreground">user</span>
                    <span class="text-foreground/80">{{ user.username }}</span>
                    <Badge v-if="user.isAdmin">admin</Badge>
                  </div>
                </TableCell>
                <TableCell v-for="field in (['canRead', 'canWrite', 'canDelete'] as const)" :key="field" class="px-3 py-2.5 text-center">
                  <Checkbox :model-value="user.isAdmin ? true : (getPerm(place.id, 'user', user.id)?.[field] ?? false)" :disabled="user.isAdmin" @update:model-value="!user.isAdmin && togglePerm(place.id, 'user', user.id, field)" />
                </TableCell>
              </TableRow>

              <TableRow v-if="groups.length === 0 && users.length === 0">
                <TableCell colspan="4" class="px-4 py-3 text-muted-foreground">No groups or users to assign.</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  </section>
</template>
