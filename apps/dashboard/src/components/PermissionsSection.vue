<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { trpc } from '../lib/trpc'

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
    <h3 class="text-xs font-medium uppercase tracking-widest text-[var(--c-text-3)] mb-3 px-1">Permissions</h3>

    <div v-if="places.length === 0" class="text-sm text-[var(--c-text-3)] italic px-1">No places configured.</div>

    <div class="space-y-2">
      <div
        v-for="place in places"
        :key="place.id"
        class="bg-[var(--c-surface)] border border-[var(--c-border)] rounded-xl overflow-hidden"
      >
        <!-- Place header (accordion) -->
        <button
          @click="togglePlace(place.id)"
          class="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--c-hover)] transition-colors"
        >
          <div>
            <span class="text-sm font-medium text-[var(--c-text-1)]">{{ place.name }}</span>
            <span class="ml-2 text-xs text-[var(--c-text-3)] font-mono">{{ place.path }}</span>
          </div>
          <svg
            :class="['w-3.5 h-3.5 text-[var(--c-text-3)] transition-transform', expandedPlace === place.id ? 'rotate-180' : '']"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
          </svg>
        </button>

        <!-- Permission matrix -->
        <div v-if="expandedPlace === place.id" class="border-t border-[var(--c-border)]">
          <p class="px-4 py-1.5 text-[11px] text-[var(--c-text-3)] leading-relaxed">Admins always have full access.</p>
          <table class="w-full text-xs">
            <thead>
              <tr class="text-[var(--c-text-3)] uppercase tracking-wider border-b border-[var(--c-border)]">
                <th class="px-4 py-2 text-left font-medium">Subject</th>
                <th class="px-3 py-2 text-center font-medium w-16">Read</th>
                <th class="px-3 py-2 text-center font-medium w-16">Write</th>
                <th class="px-3 py-2 text-center font-medium w-16">Delete</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[var(--c-border)]">
              <!-- Groups -->
              <tr v-for="group in groups" :key="'group-' + group.id">
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-1.5">
                    <span class="badge badge-violet">group</span>
                    <span class="text-[var(--c-text-2)]">{{ group.name }}</span>
                  </div>
                </td>
                <td v-for="field in (['canRead', 'canWrite', 'canDelete'] as const)" :key="field" class="px-3 py-2.5 text-center">
                  <input
                    type="checkbox"
                    :checked="getPerm(place.id, 'group', group.id)?.[field] ?? false"
                    @change="togglePerm(place.id, 'group', group.id, field)"
                    class="w-3.5 h-3.5 rounded accent-accent cursor-pointer"
                  />
                </td>
              </tr>

              <!-- Users (admins always have full access) -->
              <tr v-for="user in users" :key="'user-' + user.id">
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-1.5">
                    <span class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-[var(--c-surface-deep)] text-[var(--c-text-3)]">user</span>
                    <span class="text-[var(--c-text-2)]">{{ user.username }}</span>
                    <span v-if="user.isAdmin" class="badge badge-admin">admin</span>
                  </div>
                </td>
                <td v-for="field in (['canRead', 'canWrite', 'canDelete'] as const)" :key="field" class="px-3 py-2.5 text-center">
                  <input
                    type="checkbox"
                    :checked="user.isAdmin ? true : (getPerm(place.id, 'user', user.id)?.[field] ?? false)"
                    :disabled="user.isAdmin"
                    @change="!user.isAdmin && togglePerm(place.id, 'user', user.id, field)"
                    class="w-3.5 h-3.5 rounded accent-accent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                </td>
              </tr>

              <tr v-if="groups.length === 0 && users.length === 0">
                <td colspan="4" class="px-4 py-3 text-[var(--c-text-3)] italic">No groups or users to assign.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>
