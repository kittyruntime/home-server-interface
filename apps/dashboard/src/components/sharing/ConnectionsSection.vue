<script setup lang="ts">
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
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

    <Card v-else-if="connections.length === 0" class="block gap-0 py-0 overflow-hidden p-4"><EmptyState message="No active SMB connections." description="New SMB sessions will appear here automatically." /></Card>

    <Card v-else class="block gap-0 py-0 overflow-hidden">
      <div class="divide-y divide-border sm:hidden"><article v-for="(c,i) in connections" :key="i" class="space-y-2 p-4"><div class="flex items-center justify-between gap-2"><strong class="truncate text-sm text-foreground">{{c.user||'guest'}}</strong><Badge variant="secondary">{{c.share}}</Badge></div><dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"><dt class="text-muted-foreground">Client</dt><dd class="truncate font-mono text-foreground/80" :title="c.client">{{c.client}}</dd><dt class="text-muted-foreground">Connected</dt><dd class="font-mono text-foreground/80">{{c.connectedAt}}</dd></dl></article></div>
      <div class="hidden sm:block">
      <Table class="w-full text-sm">
        <TableHeader>
          <TableRow class="border-b border-border">
            <TableHead class="eyebrow text-left px-4 py-3">User</TableHead>
            <TableHead class="eyebrow text-left px-4 py-3">Share</TableHead>
            <TableHead class="eyebrow text-left px-4 py-3">Client</TableHead>
            <TableHead class="eyebrow text-left px-4 py-3">Connected</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow
            v-for="(c, i) in connections"
            :key="i"
            class="border-b border-border last:border-b-0"
          >
            <TableCell class="px-4 py-2.5 text-foreground">{{ c.user || 'guest' }}</TableCell>
            <TableCell class="px-4 py-2.5 text-foreground/80">{{ c.share }}</TableCell>
            <TableCell class="px-4 py-2.5 font-mono text-xs text-foreground/80">{{ c.client }}</TableCell>
            <TableCell class="px-4 py-2.5 font-mono text-xs text-muted-foreground">{{ c.connectedAt }}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      </div>
    </Card>
  </div>
</template>
