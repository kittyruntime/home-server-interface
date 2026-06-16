<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import RoleEditor from './RoleEditor.vue'

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
const newRoleName  = ref('')
const createError  = ref('')

const usernames  = computed(() => new Set(users.value.map(u => u.username)))
function isPersonal(role: Role) { return usernames.value.has(role.name) }

// ── Pagination ──────────────────────────────────────────────────────────────
const PAGE_SIZE = 10
const page      = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(roles.value.length / PAGE_SIZE)))
const paged     = computed(() => roles.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
function goPage(n: number) { page.value = Math.max(1, Math.min(n, pageCount.value)) }

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
  try {
    await trpc.role.create.mutate({ name })
    newRoleName.value = ''
    await load()
    page.value = pageCount.value
  } catch (e: any) {
    createError.value = e?.message ?? 'Failed to create role'
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
            {{ roles.length }} role{{ roles.length !== 1 ? 's' : '' }} configured
          </p>
        </div>
      </div>

      <!-- List -->
      <div class="panel-card">
        <div v-if="roles.length === 0"
          class="px-5 py-10 text-center text-sm text-[var(--c-text-3)] italic">
          No roles yet.
        </div>

        <div v-else class="divide-y divide-[var(--c-border)]">
          <div
            v-for="role in paged"
            :key="role.id"
            class="flex items-center gap-4 px-5 py-3.5 bg-[var(--c-bg)] hover:bg-[var(--c-surface)] transition-colors"
          >
            <!-- Name + badges -->
            <div class="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
              <span class="text-sm font-medium text-[var(--c-text-1)] truncate">{{ role.name }}</span>
              <span v-if="role.isAdmin"
                class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--c-accent-subtle)] text-[var(--c-accent)] shrink-0">
                admin
              </span>
              <span v-if="isPersonal(role)"
                class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border border-[var(--c-border-strong)] text-[var(--c-text-3)] shrink-0">
                personal
              </span>
            </div>

            <!-- Meta -->
            <div class="hidden sm:flex items-center gap-3 text-xs text-[var(--c-text-3)] shrink-0">
              <span class="flex items-center gap-1" title="Members">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a4 4 0 00-5.916-3.5M9 20H4v-2a4 4 0 015.916-3.5M15 7a3 3 0 11-6 0 3 3 0 016 0zM21 10a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/>
                </svg>
                {{ role.userRoles.length }}
              </span>
              <span class="flex items-center gap-1" title="Permissions">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
                </svg>
                {{ role.permissions.length }}
              </span>
            </div>

            <!-- Edit button -->
            <button
              @click="openEditor(role)"
              class="shrink-0 text-xs px-2.5 py-1 rounded-lg border border-[var(--c-border-strong)] text-[var(--c-text-3)]
                     hover:border-[var(--c-accent)] hover:text-[var(--c-accent)] hover:bg-[var(--c-accent-subtle)] transition-colors"
            >Edit</button>
          </div>
        </div>
      </div>

      <!-- Pagination -->
      <div v-if="pageCount > 1" class="flex items-center justify-between px-1">
        <span class="text-xs text-[var(--c-text-3)]">
          {{ (page - 1) * PAGE_SIZE + 1 }}–{{ Math.min(page * PAGE_SIZE, roles.length) }} of {{ roles.length }}
        </span>
        <div class="flex items-center gap-1">
          <button
            @click="goPage(page - 1)"
            :disabled="page === 1"
            class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/>
            </svg>
          </button>
          <template v-for="n in pageCount" :key="n">
            <button
              @click="goPage(n)"
              :class="[
                'w-7 h-7 rounded-lg text-xs font-medium transition-colors',
                n === page
                  ? 'bg-[var(--c-accent)] text-[var(--c-accent-fg)]'
                  : 'text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)]',
              ]"
            >{{ n }}</button>
          </template>
          <button
            @click="goPage(page + 1)"
            :disabled="page === pageCount"
            class="p-1.5 rounded-lg text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Create role -->
      <form @submit.prevent="createRole" class="flex gap-2">
        <input
          v-model="newRoleName"
          placeholder="New role name…"
          class="ui-input flex-1"
        />
        <button
          type="submit"
          :disabled="!newRoleName.trim()"
          class="btn btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
        >Add</button>
      </form>
      <p v-if="createError" class="text-red-400 text-xs">{{ createError }}</p>

    </section>
  </div>
</template>
