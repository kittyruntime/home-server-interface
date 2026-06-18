<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import { useAuth } from '../lib/auth'
import { useTheme, useAccent, type Accent } from '../lib/theme'
import LoadingSpinner from './ui/LoadingSpinner.vue'

type Me = {
  id: string
  username: string
  displayName: string | null
  linuxUsername: string | null
  userRoles: { role: { id: string; name: string; isAdmin: boolean; permissions: { permission: { name: string } }[] } }[]
}

function matchesPerm(grants: string[], required: string): boolean {
  const [rNs] = required.split('.')
  return grants.some(g => g === required || g === '*.*' || (() => { const [ns, act] = g.split('.'); return ns === rNs && act === '*' })())
}
const meIsAdmin = computed(() => !!me.value && me.value.userRoles.some(ur => ur.role.isAdmin))
const meCanManage = computed(() => {
  if (!me.value) return false
  const grants = me.value.userRoles.flatMap(ur => ur.role.permissions.map(rp => rp.permission.name))
  return meIsAdmin.value || matchesPerm(grants, 'users.manage')
})

useAuth()

const { theme, setTheme } = useTheme()
const { accent, setAccent } = useAccent()

const THEME_OPTIONS: { value: 'auto' | 'light' | 'dark'; label: string }[] = [
  { value: 'auto',  label: 'Auto'  },
  { value: 'light', label: 'Light' },
  { value: 'dark',  label: 'Dark'  },
]

const ACCENT_OPTIONS: { value: Accent; color: string; label: string }[] = [
  { value: 'orange', color: '#f97316', label: 'Orange' },
  { value: 'blue',   color: '#3b82f6', label: 'Blue'   },
  { value: 'green',  color: '#22c55e', label: 'Green'  },
  { value: 'purple', color: '#a855f7', label: 'Purple' },
]

const me      = ref<Me | null>(null)
const loading = ref(true)

// ── Display name ──────────────────────────────────────────────────────────────
const editingName  = ref(false)
const nameValue    = ref('')
const nameLoading  = ref(false)
const nameError    = ref('')
const nameSuccess  = ref(false)

function startEditName() {
  nameValue.value  = me.value?.displayName ?? ''
  nameError.value  = ''
  nameSuccess.value = false
  editingName.value = true
}

async function saveName() {
  nameError.value = ''
  nameLoading.value = true
  try {
    const updated = await trpc.user.updateSelf.mutate({ displayName: nameValue.value.trim() || null })
    me.value = { ...me.value!, displayName: (updated as any).displayName }
    editingName.value = false
    nameSuccess.value = true
    setTimeout(() => { nameSuccess.value = false }, 3000)
  } catch (e: any) {
    nameError.value = e?.message ?? 'Failed to update'
  } finally {
    nameLoading.value = false
  }
}

// ── Change password ───────────────────────────────────────────────────────────
const pwOpen    = ref(false)
const pwForm    = reactive({ current: '', next: '', confirm: '' })
const pwError   = ref('')
const pwSuccess = ref(false)
const pwLoading = ref(false)

function openPassword() {
  pwSuccess.value = false
  pwError.value   = ''
  Object.assign(pwForm, { current: '', next: '', confirm: '' })
  pwOpen.value = true
}

async function submitPassword() {
  pwError.value   = ''
  pwSuccess.value = false
  if (pwForm.next !== pwForm.confirm) { pwError.value = 'Passwords do not match'; return }
  if (pwForm.next.length < 6)         { pwError.value = 'New password must be at least 6 characters'; return }
  pwLoading.value = true
  try {
    await trpc.user.changePassword.mutate({ currentPassword: pwForm.current, newPassword: pwForm.next })
    pwSuccess.value = true
    Object.assign(pwForm, { current: '', next: '', confirm: '' })
  } catch (e: any) {
    pwError.value = e?.message ?? 'Failed to change password'
  } finally {
    pwLoading.value = false
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
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

onMounted(async () => {
  try { me.value = (await trpc.user.me.query()) as Me }
  finally { loading.value = false }
})
</script>

<template>
  <div class="space-y-8">

    <!-- Loading -->
    <div v-if="loading" class="flex items-center text-[var(--c-text-3)] text-sm py-4">
      <LoadingSpinner />
    </div>

    <template v-else-if="me">

      <!-- ── Identity card ── -->
      <div class="flex items-center gap-4">
        <!-- Avatar -->
        <div :class="['w-14 h-14 rounded-2xl bg-gradient-to-br flex items-center justify-center text-white text-lg font-bold shrink-0 select-none', avatarGradient(me.username)]">
          {{ me.username.slice(0, 2).toUpperCase() }}
        </div>

        <!-- Name + badges -->
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[var(--c-text-1)] text-lg font-semibold leading-tight">
              {{ me.displayName || me.username }}
            </span>
            <span v-if="me.displayName" class="text-[var(--c-text-3)] text-sm">{{ me.username }}</span>
            <span v-if="meIsAdmin" class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--c-accent-subtle)] text-[var(--c-accent)]">admin</span>
            <span v-if="!meIsAdmin && meCanManage" class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/15 text-violet-400">manager</span>
          </div>
          <!-- Roles -->
          <div class="flex flex-wrap gap-1 mt-1.5">
            <span v-for="ur in me.userRoles.filter(ur => ur.role.name !== me!.username)" :key="ur.role.id"
              class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/10 text-violet-400">
              {{ ur.role.name }}
            </span>
            <span v-if="me.linuxUsername" class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--c-surface-deep)] text-[var(--c-text-3)]">
              {{ me.linuxUsername }}
            </span>
          </div>
        </div>
      </div>

      <!-- ── Display name ── -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Display name</h4>
          <button v-if="!editingName" @click="startEditName"
            class="text-xs text-[var(--c-text-3)] hover:text-[var(--c-text-2)] transition-colors">
            Edit
          </button>
        </div>

        <div v-if="!editingName" class="bg-[var(--c-surface)] border border-[var(--c-border)] rounded-xl px-4 py-3 flex items-center justify-between">
          <span :class="me.displayName ? 'text-[var(--c-text-1)] text-sm' : 'text-[var(--c-text-3)] text-sm italic'">
            {{ me.displayName || 'Not set' }}
          </span>
          <span v-if="nameSuccess" class="text-xs text-[var(--c-success)]">Saved</span>
        </div>

        <div v-else class="bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-xl p-4 space-y-3">
          <input
            v-model="nameValue"
            placeholder="Your full name"
            autofocus
            @keydown.enter="saveName"
            @keydown.escape="editingName = false"
            class="w-full bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-lg px-3 py-1.5 text-sm text-[var(--c-text-1)] placeholder:text-[var(--c-text-3)] focus:outline-none focus:border-[var(--c-accent)]"
          />
          <p v-if="nameError" class="text-[var(--c-accent)] text-xs">{{ nameError }}</p>
          <div class="flex gap-2">
            <button @click="saveName" :disabled="nameLoading"
              class="px-3 py-1.5 bg-[var(--c-accent)] hover:opacity-90 disabled:opacity-40 text-[var(--c-accent-fg)] text-sm font-medium rounded-lg transition-colors">
              {{ nameLoading ? 'Saving…' : 'Save' }}
            </button>
            <button @click="editingName = false"
              class="px-3 py-1.5 text-[var(--c-text-3)] hover:text-[var(--c-text-1)] text-sm transition-colors">
              Cancel
            </button>
          </div>
        </div>
      </div>

      <!-- ── Change password ── -->
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Password</h4>
          <button v-if="!pwOpen" @click="openPassword"
            class="text-xs text-[var(--c-text-3)] hover:text-[var(--c-text-2)] transition-colors">
            Change
          </button>
        </div>

        <div v-if="!pwOpen" class="bg-[var(--c-surface)] border border-[var(--c-border)] rounded-xl px-4 py-3">
          <span class="text-[var(--c-text-3)] text-sm tracking-widest select-none">••••••••</span>
        </div>

        <div v-else class="bg-[var(--c-surface-alt)] border border-[var(--c-border-strong)] rounded-xl p-4 space-y-3">
          <div v-if="pwSuccess" class="flex items-center gap-2 text-[var(--c-success)] text-sm py-1">
            <svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
            </svg>
            Password updated successfully.
          </div>

          <template v-else>
            <div>
              <label class="block text-xs text-[var(--c-text-3)] mb-1">Current password</label>
              <input v-model="pwForm.current" type="password" placeholder="••••••••" autofocus
                class="w-full bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-lg px-3 py-1.5 text-sm text-[var(--c-text-1)] placeholder:text-[var(--c-text-3)] focus:outline-none focus:border-[var(--c-accent)]"/>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label class="block text-xs text-[var(--c-text-3)] mb-1">New password</label>
                <input v-model="pwForm.next" type="password" placeholder="Min. 6 chars"
                  class="w-full bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-lg px-3 py-1.5 text-sm text-[var(--c-text-1)] placeholder:text-[var(--c-text-3)] focus:outline-none focus:border-[var(--c-accent)]"/>
              </div>
              <div>
                <label class="block text-xs text-[var(--c-text-3)] mb-1">Confirm</label>
                <input v-model="pwForm.confirm" type="password" placeholder="Repeat"
                  @keydown.enter="submitPassword"
                  class="w-full bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-lg px-3 py-1.5 text-sm text-[var(--c-text-1)] placeholder:text-[var(--c-text-3)] focus:outline-none focus:border-[var(--c-accent)]"/>
              </div>
            </div>
            <p v-if="pwError" class="text-[var(--c-accent)] text-xs">{{ pwError }}</p>
            <div class="flex gap-2">
              <button @click="submitPassword" :disabled="pwLoading || !pwForm.current || !pwForm.next"
                class="px-3 py-1.5 bg-[var(--c-accent)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed text-[var(--c-accent-fg)] text-sm font-medium rounded-lg transition-colors">
                {{ pwLoading ? 'Saving…' : 'Update password' }}
              </button>
              <button @click="pwOpen = false"
                class="px-3 py-1.5 text-[var(--c-text-3)] hover:text-[var(--c-text-1)] text-sm transition-colors">
                Cancel
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- ── Theme ── -->
      <div class="space-y-2">
        <h4 class="text-xs font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Theme</h4>
        <div class="bg-[var(--c-surface)] border border-[var(--c-border)] rounded-xl px-4 py-3 flex items-center gap-2">
          <button
            v-for="opt in THEME_OPTIONS"
            :key="opt.value"
            @click="setTheme(opt.value)"
            :class="[
              'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              theme === opt.value
                ? 'bg-[var(--c-accent-subtle)] text-[var(--c-accent)]'
                : 'text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)]',
            ]"
          >{{ opt.label }}</button>
        </div>
      </div>

      <!-- ── Accent color ── -->
      <div class="space-y-2">
        <h4 class="text-xs font-semibold uppercase tracking-widest text-[var(--c-text-3)]">Accent color</h4>
        <div class="bg-[var(--c-surface)] border border-[var(--c-border)] rounded-xl px-4 py-3 flex items-center gap-3">
          <button
            v-for="opt in ACCENT_OPTIONS"
            :key="opt.value"
            @click="setAccent(opt.value)"
            :title="opt.label"
            :style="{ backgroundColor: opt.color }"
            :class="[
              'w-6 h-6 rounded-full transition-all',
              accent === opt.value
                ? 'ring-2 ring-offset-2 ring-offset-[var(--c-surface)] ring-[var(--c-accent)] scale-110'
                : 'opacity-60 hover:opacity-100',
            ]"
          />
          <span class="text-xs text-[var(--c-text-3)] ml-1">{{ ACCENT_OPTIONS.find(o => o.value === accent)?.label }}</span>
        </div>
      </div>

    </template>
  </div>
</template>
