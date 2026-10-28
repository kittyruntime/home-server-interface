<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { trpc } from '../../lib/trpc'
import LoadingState from '../ui/LoadingState.vue'
import EmptyState from '../ui/EmptyState.vue'
import { Badge } from '@/components/ui/badge'

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
      <h2 class="text-lg font-semibold text-foreground">Active connections</h2>
    </div>

    <p v-if="error" class="status-text text-destructive mb-4">[ERR] {{ error }}</p>

    <LoadingState v-if="loading" variant="compact" />

    <div v-else-if="connections.length === 0" class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden bg-card p-4"><EmptyState message="No active SMB connections." description="New SMB sessions will appear here automatically." /></div>

    <div v-else class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden bg-card">
      <div class="divide-y divide-border sm:hidden"><article v-for="(c,i) in connections" :key="i" class="space-y-2 p-4"><div class="flex items-center justify-between gap-2"><strong class="truncate text-sm text-foreground">{{c.user||'guest'}}</strong><Badge variant="secondary">{{c.share}}</Badge></div><dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"><dt class="text-muted-foreground">Client</dt><dd class="truncate font-mono text-foreground/80" :title="c.client">{{c.client}}</dd><dt class="text-muted-foreground">Connected</dt><dd class="font-mono text-foreground/80">{{c.connectedAt}}</dd></dl></article></div>
      <div class="hidden sm:block">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border">
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
            class="border-b border-border last:border-b-0"
          >
            <td class="px-4 py-2.5 text-foreground">{{ c.user || 'guest' }}</td>
            <td class="px-4 py-2.5 text-foreground/80">{{ c.share }}</td>
            <td class="px-4 py-2.5 font-mono text-xs text-foreground/80">{{ c.client }}</td>
            <td class="px-4 py-2.5 font-mono text-xs text-muted-foreground">{{ c.connectedAt }}</td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  </div>
</template>
