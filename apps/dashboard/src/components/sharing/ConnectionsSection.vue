<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { trpc } from '../../lib/trpc'
import LoadingState from '../ui/LoadingState.vue'
import EmptyState from '../ui/EmptyState.vue'

type Connection = { user: string; share: string; client: string; connectedAt: string }

const connections = ref<Connection[]>([])
const loading = ref(true)
const error   = ref('')
let timer: ReturnType<typeof setInterval> | null = null

async function poll() {
  try {
    const res = await trpc.sharing.status.query()
    connections.value = res.connections
    error.value = ''
  } catch (e: unknown) {
    error.value = (e as { message?: string })?.message ?? 'Failed to load connections'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  poll()
  timer = setInterval(poll, 5000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div>
    <div class="mb-6">
      <p class="eyebrow mb-1">Network sharing</p>
      <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Active connections</h2>
    </div>

    <p v-if="error" class="status-text text-[var(--c-danger)] mb-4">[ERR] {{ error }}</p>

    <LoadingState v-if="loading" variant="compact" />

    <div v-else-if="connections.length === 0" class="panel-card bg-[var(--c-surface)] p-4"><EmptyState message="No active SMB connections." description="New SMB sessions will appear here automatically." /></div>

    <div v-else class="panel-card bg-[var(--c-surface)]">
      <div class="divide-y divide-[var(--c-border)] sm:hidden"><article v-for="(c,i) in connections" :key="i" class="space-y-2 p-4"><div class="flex items-center justify-between gap-2"><strong class="truncate text-sm text-[var(--c-text-1)]">{{c.user||'guest'}}</strong><span class="badge badge-muted">{{c.share}}</span></div><dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"><dt class="text-[var(--c-text-3)]">Client</dt><dd class="truncate font-mono text-[var(--c-text-2)]" :title="c.client">{{c.client}}</dd><dt class="text-[var(--c-text-3)]">Connected</dt><dd class="font-mono text-[var(--c-text-2)]">{{c.connectedAt}}</dd></dl></article></div>
      <div class="hidden sm:block">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-[var(--c-border)]">
            <th class="eyebrow text-left px-4 py-3">User</th>
            <th class="eyebrow text-left px-4 py-3">Share</th>
            <th class="eyebrow text-left px-4 py-3">Client</th>
            <th class="eyebrow text-left px-4 py-3">Connected</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(c, i) in connections"
            :key="i"
            class="border-b border-[var(--c-border)] last:border-b-0"
          >
            <td class="px-4 py-2.5 text-[var(--c-text-1)]">{{ c.user || 'guest' }}</td>
            <td class="px-4 py-2.5 text-[var(--c-text-2)]">{{ c.share }}</td>
            <td class="px-4 py-2.5 font-mono text-xs text-[var(--c-text-2)]">{{ c.client }}</td>
            <td class="px-4 py-2.5 font-mono text-xs text-[var(--c-text-3)]">{{ c.connectedAt }}</td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  </div>
</template>
