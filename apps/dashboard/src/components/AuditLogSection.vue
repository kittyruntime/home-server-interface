<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { trpc } from '../lib/trpc'

type AuditEntry = Awaited<ReturnType<typeof trpc.audit.list.query>>['entries'][number]

const PAGE_SIZE = 50

const page          = ref(0)
const filterAction  = ref('')
const loading       = ref(false)
const error         = ref('')
const entries       = ref<AuditEntry[]>([])
const total         = ref(0)
const pages         = ref(1)
const selectedEntry = ref<AuditEntry | null>(null)

async function load() {
  loading.value = true
  error.value   = ''
  try {
    const res = await trpc.audit.list.query({
      page:   page.value,
      limit:  PAGE_SIZE,
      action: filterAction.value || undefined,
    })
    entries.value = res.entries
    total.value   = res.total
    pages.value   = Math.max(1, Math.ceil(res.total / PAGE_SIZE))
  } catch (e: unknown) {
    // Surface the failure instead of falling through to the empty state, which
    // would misrepresent a load error as "no activity".
    error.value = (e as { message?: string })?.message ?? 'Failed to load the audit log'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch([page], load)
watch([filterAction], () => { page.value = 0; load() })

function fmtDate(d: string | Date) {
  return new Date(d).toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    'auth.login':                   'Login',
    'auth.logout':                  'Logout',
    'fs.delete':                    'Delete file',
    'fs.mkdir':                     'Create folder',
    'fs.rename':                    'Rename',
    'fs.move':                      'Move',
    'fs.copy':                      'Copy',
    'system.formatDisk':            'Format disk',
    'system.mountDevice':           'Mount device',
    'system.umountDevice':          'Unmount device',
    'system.initPartitionTable':    'Init partition table',
    'system.createPartition':       'Create partition',
    'system.deletePartition':       'Delete partition',
    'system.createRaid':            'Create RAID',
    'system.stopRaid':              'Stop RAID',
    'system.createPv':              'Create PV',
    'system.createVg':              'Create VG',
    'system.createLv':              'Create LV',
    'system.removeLv':              'Remove LV',
    'system.removeVg':              'Remove VG',
    'user.create':                  'Create user',
    'user.update':                  'Update user',
    'user.delete':                  'Delete user',
    'user.changePassword':          'Change password',
    'container.create':             'Create container',
    'container.delete':             'Delete container',
    'container.start':              'Start container',
    'container.stop':               'Stop container',
    'container.restart':            'Restart container',
    'place.create':                 'Create place',
    'place.delete':                 'Delete place',
    'role.create':                  'Create role',
    'role.delete':                  'Delete role',
    'update.trigger':               'Trigger update',
  }
  return map[action] ?? action
}

type Category = 'auth' | 'fs' | 'system' | 'admin' | 'other'

function actionCategory(action: string): Category {
  if (action.startsWith('auth.'))     return 'auth'
  if (action.startsWith('fs.'))       return 'fs'
  if (action.startsWith('system.'))   return 'system'
  if (action.startsWith('user.') || action.startsWith('role.') ||
      action.startsWith('place.') || action.startsWith('container.') ||
      action.startsWith('update.'))   return 'admin'
  return 'other'
}

const categoryClass: Record<Category, string> = {
  auth:   'bg-info/10 text-info border-info/20',
  fs:     'bg-violet/10 text-violet border-violet/20',
  system: 'bg-warning/10 text-warning border-warning/20',
  admin:  'bg-accent/10 text-accent border-accent/20',
  other:  'bg-[var(--c-surface-deep)] text-[var(--c-text-3)] border-[var(--c-border)]',
}

function parseMeta(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try { return JSON.parse(raw) as Record<string, unknown> } catch { return null }
}
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-[var(--c-text-1)] mb-1">Audit Log</h2>
    <p class="text-sm text-[var(--c-text-3)] mb-6">All actions performed by authenticated users.</p>

    <!-- Filter -->
    <div class="flex gap-3 mb-5">
      <div class="relative flex-1 min-w-48">
        <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--c-text-3)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
        <input v-model="filterAction" placeholder="Filter by action…"
          class="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] text-[var(--c-text-1)] placeholder:text-[var(--c-text-3)] focus:outline-none focus:border-[var(--c-accent)]/50" />
      </div>
      <button @click="load" :disabled="loading"
        class="px-3 py-2 rounded-lg border border-[var(--c-border)] text-sm text-[var(--c-text-2)] hover:bg-[var(--c-hover)] transition-colors disabled:opacity-50">
        <svg :class="['w-4 h-4', loading ? 'animate-spin' : '']" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading && !entries.length" class="flex items-center justify-center py-16 text-[var(--c-text-3)] text-sm gap-2">
      <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
      </svg>
      Loading…
    </div>

    <!-- Error -->
    <div v-else-if="error" class="flex flex-col items-center gap-3 py-16 text-center">
      <div class="text-sm text-danger">{{ error }}</div>
      <button @click="load" class="btn btn-outline btn-sm">
        Retry
      </button>
    </div>

    <!-- Empty -->
    <div v-else-if="!entries.length" class="text-center py-16 text-[var(--c-text-3)] text-sm">
      No audit entries found.
    </div>

    <!-- Table -->
    <template v-else>
      <div class="rounded-xl border border-[var(--c-border)] overflow-hidden">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="bg-[var(--c-surface-deep)] border-b border-[var(--c-border)] text-[var(--c-text-3)] text-xs uppercase tracking-wide">
              <th class="text-left px-4 py-3 font-medium w-44">Time</th>
              <th class="text-left px-4 py-3 font-medium w-32">User</th>
              <th class="text-left px-4 py-3 font-medium">Action</th>
              <th class="text-left px-4 py-3 font-medium max-w-0">Target</th>
              <th class="text-left px-4 py-3 font-medium w-28">IP</th>
              <th class="text-center px-4 py-3 font-medium w-16">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--c-border)]">
            <template v-for="entry in entries" :key="entry.id">
              <tr @click="selectedEntry = selectedEntry?.id === entry.id ? null : entry"
                :class="['cursor-pointer transition-colors hover:bg-[var(--c-hover)]/40',
                  selectedEntry?.id === entry.id ? 'bg-[var(--c-accent)]/5' : '',
                  !entry.success ? 'bg-danger/4' : '']">

                <td class="px-4 py-2.5 text-xs text-[var(--c-text-3)] font-mono whitespace-nowrap">
                  {{ fmtDate(entry.createdAt) }}
                </td>
                <td class="px-4 py-2.5">
                  <span v-if="entry.user" class="text-[var(--c-text-1)] font-medium text-xs">
                    {{ entry.user.displayName || entry.user.username }}
                  </span>
                  <span v-else class="text-[var(--c-text-3)] text-xs italic">—</span>
                </td>
                <td class="px-4 py-2.5">
                  <span :class="['inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-sm border', categoryClass[actionCategory(entry.action)]]">
                    {{ actionLabel(entry.action) }}
                  </span>
                </td>
                <td class="px-4 py-2.5 max-w-0">
                  <span v-if="entry.target" class="font-mono text-xs text-[var(--c-text-2)] truncate block" :title="entry.target">
                    {{ entry.target }}
                  </span>
                  <span v-else class="text-[var(--c-text-3)] text-xs">—</span>
                </td>
                <td class="px-4 py-2.5 font-mono text-xs text-[var(--c-text-3)] whitespace-nowrap">
                  {{ entry.ip ?? '—' }}
                </td>
                <td class="px-4 py-2.5 text-center">
                  <span v-if="entry.success"
                    class="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-sm bg-success/10 text-success">
                    <span class="w-1.5 h-1.5 rounded-full bg-success"/>OK
                  </span>
                  <span v-else
                    class="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-sm bg-danger/10 text-danger">
                    <span class="w-1.5 h-1.5 rounded-full bg-danger"/>Fail
                  </span>
                </td>
              </tr>

              <!-- Expanded detail row -->
              <tr v-if="selectedEntry?.id === entry.id" :key="'detail-' + entry.id">
                <td colspan="6" class="px-4 pb-4 pt-2 bg-[var(--c-surface-deep)]/50">
                  <div class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)] mb-2">Detail</div>
                  <div class="grid grid-cols-2 gap-x-8 gap-y-1 text-xs mb-3">
                    <div><span class="text-[var(--c-text-3)]">ID </span><span class="font-mono text-[var(--c-text-2)]">{{ entry.id }}</span></div>
                    <div><span class="text-[var(--c-text-3)]">Action </span><span class="font-mono text-[var(--c-text-2)]">{{ entry.action }}</span></div>
                    <div v-if="entry.user">
                      <span class="text-[var(--c-text-3)]">User </span>
                      <span class="text-[var(--c-text-2)]">{{ entry.user.displayName || entry.user.username }} ({{ entry.userId }})</span>
                    </div>
                    <div v-if="entry.target"><span class="text-[var(--c-text-3)]">Target </span><span class="font-mono text-[var(--c-text-2)]">{{ entry.target }}</span></div>
                  </div>
                  <template v-if="parseMeta(entry.meta)">
                    <div class="text-[10px] font-semibold uppercase tracking-widest text-[var(--c-text-3)] mb-1.5">Input</div>
                    <pre class="text-[10px] font-mono bg-[var(--c-surface-deep)] border border-[var(--c-border)] rounded-lg px-3 py-2 overflow-x-auto text-[var(--c-text-2)] whitespace-pre-wrap">{{ JSON.stringify(parseMeta(entry.meta), null, 2) }}</pre>
                  </template>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div class="flex items-center justify-between mt-4 text-sm text-[var(--c-text-3)]">
        <span>{{ total.toLocaleString() }} entr{{ total === 1 ? 'y' : 'ies' }}</span>
        <div class="flex items-center gap-1">
          <button @click="page--" :disabled="page === 0 || loading"
            class="px-3 py-1.5 rounded-lg border border-[var(--c-border)] text-xs disabled:opacity-30 enabled:hover:bg-[var(--c-hover)] transition-colors">
            ← Prev
          </button>
          <span class="px-3 py-1.5 text-xs">{{ page + 1 }} / {{ pages }}</span>
          <button @click="page++" :disabled="page >= pages - 1 || loading"
            class="px-3 py-1.5 rounded-lg border border-[var(--c-border)] text-xs disabled:opacity-30 enabled:hover:bg-[var(--c-hover)] transition-colors">
            Next →
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
