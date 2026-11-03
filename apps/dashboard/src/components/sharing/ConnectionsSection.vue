<script setup lang="ts">
import { useNarrow } from '@/lib/viewport'
import { useI18n } from 'vue-i18n'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ref, onMounted, onUnmounted } from 'vue'
import { trpc } from '../../lib/trpc'
import LoadingState from '../ui/LoadingState.vue'
import EmptyState from '../ui/EmptyState.vue'
import { Badge } from '@/components/ui/badge'

const narrow = useNarrow()

const { t } = useI18n()

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
    error.value = (e as { message?: string })?.message ?? t('uis.sharing.ConnectionsSection.failedToLoadConnections')
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
      <p class="eyebrow mb-1">{{ t('ui.sharing.ConnectionsSection.networkSharing') }}</p>
      <h2 class="text-lg font-semibold text-base-content">{{ t('ui.sharing.ConnectionsSection.activeConnections') }}</h2>
    </div>

    <p v-if="error" class="status-text text-error mb-4">[ERR] {{ error }}</p>

    <LoadingState v-if="loading" variant="compact" />

    <Card v-else-if="connections.length === 0" class="block gap-0 py-0 overflow-hidden p-4"><EmptyState :message="t('ui.sharing.ConnectionsSection.noActiveSmbConnections')" :description="t('ui.sharing.ConnectionsSection.newSmbSessionsWillAppear')" /></Card>

    <Card v-else class="block gap-0 py-0 overflow-hidden">
      <div v-if="narrow" class="divide-y divide-base-300"><article v-for="(c,i) in connections" :key="i" class="space-y-2 p-4"><div class="flex items-center justify-between gap-2"><strong class="truncate text-sm text-base-content">{{c.user||'guest'}}</strong><Badge variant="secondary">{{c.share}}</Badge></div><dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"><dt class="text-base-content/70">{{ t('ui.sharing.ConnectionsSection.client') }}</dt><dd class="truncate font-mono text-base-content/80" :title="c.client">{{c.client}}</dd><dt class="text-base-content/70">{{ t('ui.sharing.ConnectionsSection.connected') }}</dt><dd class="font-mono text-base-content/80">{{c.connectedAt}}</dd></dl></article></div>
      <div v-else>
      <Table class="w-full text-sm">
        <TableHeader>
          <TableRow class="border-b border-base-300">
            <TableHead class="eyebrow text-left px-4 py-3">{{ t('ui.sharing.ConnectionsSection.user') }}</TableHead>
            <TableHead class="eyebrow text-left px-4 py-3">{{ t('ui.sharing.ConnectionsSection.share') }}</TableHead>
            <TableHead class="eyebrow text-left px-4 py-3">{{ t('ui.sharing.ConnectionsSection.client') }}</TableHead>
            <TableHead class="eyebrow text-left px-4 py-3">{{ t('ui.sharing.ConnectionsSection.connected') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow
            v-for="(c, i) in connections"
            :key="i"
            class="border-b border-base-300 last:border-b-0"
          >
            <TableCell class="px-4 py-2.5 text-base-content">{{ c.user || 'guest' }}</TableCell>
            <TableCell class="px-4 py-2.5 text-base-content/80">{{ c.share }}</TableCell>
            <TableCell class="px-4 py-2.5 font-mono text-xs text-base-content/80">{{ c.client }}</TableCell>
            <TableCell class="px-4 py-2.5 font-mono text-xs text-base-content/70">{{ c.connectedAt }}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      </div>
    </Card>
  </div>
</template>
