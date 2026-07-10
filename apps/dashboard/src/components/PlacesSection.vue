<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { trpc } from '../lib/trpc'

type Place = { id: string; name: string; path: string }
type Role  = { id: string; name: string; userRoles: { userId: string }[] }
type User  = { id: string; username: string; userRoles: { role: { isAdmin: boolean } }[] }
type Perm  = { id: string; placeId: string; subjectType: string; subjectId: string; canRead: boolean; canWrite: boolean; canDelete: boolean; canShare: boolean }

const places       = ref<Place[]>([])
const roles        = ref<Role[]>([])
const users        = ref<User[]>([])
const permsByPlace = ref<Record<string, Perm[]>>({})
const expandedPlace = ref<string | null>(null)
const loading      = ref(true)
const adding       = ref(false)
const newName      = ref('')
const newPath      = ref('')
const addError     = ref('')
const addLoading   = ref(false)
const pathMissing  = ref(false)

watch(newPath, () => { pathMissing.value = false })

function userIsAdmin(u: User) { return u.userRoles.some(ur => ur.role.isAdmin) }

// Hide personal roles from the matrix (users are already listed individually)
const visibleRoles = computed(() => {
  const usernames = new Set(users.value.map(u => u.username))
  return roles.value.filter(r => !usernames.has(r.name))
})

async function load() {
  const [p, r, u] = await Promise.all([
    trpc.place.list.query(),
    trpc.role.list.query(),
    trpc.user.list.query(),
  ])
  places.value = p as Place[]
  roles.value  = r as Role[]
  users.value  = u as User[]
}

async function addPlace() {
  addError.value   = ''
  pathMissing.value = false
  addLoading.value = true
  try {
    const created = await trpc.place.create.mutate({ name: newName.value.trim(), path: newPath.value.trim() })
    places.value.push(created as Place)
    newName.value = ''
    newPath.value = ''
    adding.value  = false
  } catch (e: any) {
    if (e?.message === 'Path does not exist') pathMissing.value = true
    addError.value = e?.message ?? 'Failed to add place'
  } finally {
    addLoading.value = false
  }
}

async function createDir() {
  addError.value   = ''
  addLoading.value = true
  try {
    await trpc.place.mkdir.mutate({ path: newPath.value.trim() })
    pathMissing.value = false
  } catch (e: any) {
    addError.value = e?.message ?? 'Failed to create directory'
    addLoading.value = false
    return
  }
  addLoading.value = false
  await addPlace()
}

async function deletePlace(id: string) {
  await trpc.place.delete.mutate({ id })
  places.value = places.value.filter(p => p.id !== id)
  if (expandedPlace.value === id) expandedPlace.value = null
  delete permsByPlace.value[id]
}

async function loadPerms(placeId: string) {
  permsByPlace.value[placeId] = (await trpc.permission.listForPlace.query({ placeId })) as Perm[]
}

async function togglePlace(placeId: string) {
  if (expandedPlace.value === placeId) { expandedPlace.value = null; return }
  expandedPlace.value = placeId
  await loadPerms(placeId)
}

function getPerm(placeId: string, subjectType: string, subjectId: string): Perm | undefined {
  return permsByPlace.value[placeId]?.find(p => p.subjectType === subjectType && p.subjectId === subjectId)
}

async function togglePerm(
  placeId: string,
  subjectType: 'user' | 'role',
  subjectId: string,
  field: 'canRead' | 'canWrite' | 'canDelete' | 'canShare',
) {
  const current = getPerm(placeId, subjectType, subjectId)
  const next = {
    canRead:   current?.canRead   ?? false,
    canWrite:  current?.canWrite  ?? false,
    canDelete: current?.canDelete ?? false,
    canShare:  current?.canShare  ?? false,
  }
  next[field] = !next[field]
  if (!next.canRead && !next.canWrite && !next.canDelete && !next.canShare) {
    await trpc.permission.remove.mutate({ placeId, subjectType, subjectId })
  } else {
    await trpc.permission.upsert.mutate({ placeId, subjectType, subjectId, ...next })
  }
  await loadPerms(placeId)
}

onMounted(async () => {
  try { await load() } finally { loading.value = false }
})
</script>

<template>
  <section class="space-y-4">
    <!-- Header -->
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-base font-semibold text-[var(--c-text-1)]">Places</h2>
        <p class="text-xs text-[var(--c-text-3)] mt-1 max-w-md leading-relaxed">
          Folders on your NAS that you share with people. Each place maps a friendly name to a path on
          the server, then grants read, write or delete access per user or role.
        </p>
      </div>
      <button
        v-if="!adding"
        @click="adding = true"
        class="btn btn-primary btn-xs shrink-0"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
        </svg>
        Add place
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-[var(--c-text-3)] text-sm px-1">Loading…</div>

    <template v-else>
      <!-- Add form -->
      <div v-if="adding" class="rounded-xl border border-[var(--c-border-strong)] bg-[var(--c-surface)] p-4 space-y-3">
        <h4 class="eyebrow">New place</h4>
        <div class="flex gap-3">
          <div class="flex-1">
            <label class="block text-xs text-[var(--c-text-2)] mb-1">Name</label>
            <input v-model="newName" type="text" placeholder="Media" class="ui-input"/>
            <p class="text-[11px] text-[var(--c-text-3)] mt-1 leading-relaxed">Shown to users in the file browser.</p>
          </div>
          <div class="flex-[2]">
            <label class="block text-xs text-[var(--c-text-2)] mb-1">Path</label>
            <input v-model="newPath" type="text" placeholder="/mnt/data" class="ui-input font-mono"/>
            <p class="text-[11px] text-[var(--c-text-3)] mt-1 leading-relaxed">Absolute path to a folder on the server. It must already exist.</p>
          </div>
        </div>
        <div v-if="addError" class="text-[var(--c-accent)] text-xs">{{ addError }}</div>
        <div v-if="pathMissing" class="rounded-lg bg-[var(--c-surface-alt)] border border-[var(--c-border)] px-3 py-2">
          <p class="text-xs text-[var(--c-text-2)]">This folder doesn't exist yet.</p>
          <button @click="createDir" :disabled="addLoading"
            class="text-xs text-[var(--c-accent)] underline underline-offset-2 hover:opacity-75 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity mt-0.5">
            {{ addLoading ? 'Creating…' : 'Create it and add the place' }}
          </button>
        </div>
        <div class="flex gap-2 pt-1">
          <button @click="addPlace" :disabled="addLoading || !newName.trim() || !newPath.trim()"
            class="btn btn-primary btn-sm">
            {{ addLoading ? 'Adding…' : 'Add place' }}
          </button>
          <button @click="adding = false; addError = ''; pathMissing = false"
            class="btn btn-ghost btn-sm">
            Cancel
          </button>
        </div>
      </div>

      <!-- Empty state -->
      <div v-if="places.length === 0 && !adding"
        class="rounded-xl border border-dashed border-[var(--c-border-strong)] bg-[var(--c-surface)] px-6 py-10 text-center">
        <svg class="w-10 h-10 mx-auto text-[var(--c-text-3)] opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
        </svg>
        <h4 class="text-sm font-medium text-[var(--c-text-1)] mt-3">No places yet</h4>
        <p class="text-xs text-[var(--c-text-3)] mt-1 max-w-xs mx-auto leading-relaxed">
          A place shares a folder on your NAS with users and roles — you decide exactly who can read,
          write or delete its contents.
        </p>
        <button @click="adding = true" class="btn btn-primary btn-sm mt-4 mx-auto">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
          Add your first place
        </button>
      </div>

      <!-- Places list -->
      <div v-else-if="places.length > 0" class="space-y-2">
        <div
          v-for="place in places"
          :key="place.id"
          class="bg-[var(--c-surface)] border border-[var(--c-border)] rounded-xl overflow-hidden"
        >
          <!-- Place row -->
          <div class="flex items-center gap-3 px-4 py-3 group">
            <button @click="togglePlace(place.id)" class="flex-1 flex items-center gap-3 text-left min-w-0">
              <svg class="w-4 h-4 text-[var(--c-accent)] shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
              </svg>
              <div class="flex-1 min-w-0">
                <span class="text-sm text-[var(--c-text-1)]">{{ place.name }}</span>
                <span class="text-[var(--c-text-3)] text-xs font-mono ml-3">{{ place.path }}</span>
              </div>
              <!-- Expand chevron -->
              <svg :class="['w-3.5 h-3.5 text-[var(--c-text-3)] shrink-0 transition-transform', expandedPlace === place.id ? 'rotate-180' : '']"
                fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
              </svg>
            </button>
            <button @click="deletePlace(place.id)"
              class="opacity-0 group-hover:opacity-100 p-1 rounded-sm text-[var(--c-text-3)] hover:text-[var(--c-accent)]
                     hover:bg-[var(--c-accent-subtle)] transition-all shrink-0"
              title="Remove">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>

          <!-- Permissions matrix (expanded) -->
          <div v-if="expandedPlace === place.id" class="border-t border-[var(--c-border)]">
            <div class="px-4 py-2.5 bg-[var(--c-surface-alt)]">
              <span class="eyebrow">Permissions</span>
              <p class="text-[11px] text-[var(--c-text-3)] mt-0.5 leading-relaxed">
                Choose what each user or role can do in this folder. Administrators always have full access.
              </p>
            </div>
            <table class="w-full text-xs">
              <thead>
                <tr class="text-[var(--c-text-3)] uppercase tracking-wider border-b border-[var(--c-border)] bg-[var(--c-surface-alt)]">
                  <th class="px-4 py-2 text-left font-medium">Subject</th>
                  <th class="px-3 py-2 text-center font-medium w-16" title="List and download files">Read</th>
                  <th class="px-3 py-2 text-center font-medium w-16" title="Upload, rename and modify files">Write</th>
                  <th class="px-3 py-2 text-center font-medium w-16" title="Remove files and folders">Delete</th>
                  <th class="px-3 py-2 text-center font-medium w-16" title="Create public share links for this folder">Share</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--c-border)]">
                <!-- Roles (personal roles hidden — users are listed individually below) -->
                <tr v-for="role in visibleRoles" :key="'role-' + role.id">
                  <td class="px-4 py-2.5">
                    <div class="flex items-center gap-1.5">
                      <span class="badge badge-violet">role</span>
                      <span class="text-[var(--c-text-2)]">{{ role.name }}</span>
                    </div>
                  </td>
                  <td v-for="field in (['canRead', 'canWrite', 'canDelete', 'canShare'] as const)" :key="field" class="px-3 py-2.5 text-center">
                    <input type="checkbox"
                      :checked="getPerm(place.id, 'role', role.id)?.[field] ?? false"
                      @change="togglePerm(place.id, 'role', role.id, field)"
                      class="w-3.5 h-3.5 rounded accent-accent cursor-pointer"/>
                  </td>
                </tr>

                <!-- Users (skip admins — they always have full access) -->
                <tr v-for="user in users.filter(u => !userIsAdmin(u))" :key="'user-' + user.id">
                  <td class="px-4 py-2.5">
                    <div class="flex items-center gap-1.5">
                      <span class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-[var(--c-surface-deep)] text-[var(--c-text-3)]">user</span>
                      <span class="text-[var(--c-text-2)]">{{ user.username }}</span>
                    </div>
                  </td>
                  <td v-for="field in (['canRead', 'canWrite', 'canDelete', 'canShare'] as const)" :key="field" class="px-3 py-2.5 text-center">
                    <input type="checkbox"
                      :checked="getPerm(place.id, 'user', user.id)?.[field] ?? false"
                      @change="togglePerm(place.id, 'user', user.id, field)"
                      class="w-3.5 h-3.5 rounded accent-accent cursor-pointer"/>
                  </td>
                </tr>

                <tr v-if="visibleRoles.length === 0 && !users.some(u => !userIsAdmin(u))">
                  <td colspan="5" class="px-4 py-3 text-[var(--c-text-3)] italic">No roles or users to assign.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
