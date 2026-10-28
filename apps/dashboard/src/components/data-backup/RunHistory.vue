<script setup lang="ts">
import Tip from '../ui/Tip.vue'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { onMounted, ref } from 'vue'
import { trpc } from '../../lib/trpc'
import { formatDateTime } from '../../lib/format-date'
import { bytesLabel, durationLabel, runLabel, TONE_CLASS } from '../../lib/backup'
import Modal from '../ui/Modal.vue'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'
import EmptyState from '../ui/EmptyState.vue'
import { Badge } from '@/components/ui/badge'

// The recent runs of a plan, or the checks of a repository, newest first.
const props = defineProps<{ kind: 'runs' | 'checks'; id: string; title: string }>()
const emit = defineEmits<{ close: [] }>()

type Run = Awaited<ReturnType<typeof trpc.backup.runs.query>>[number]

const runs = ref<Run[]>([])
const loading = ref(true)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    runs.value = await trpc.backup.runs.query({ kind: props.kind, id: props.id, limit: 50 })
  } catch (e) {
    error.value = e instanceof Error && e.message ? e.message : 'Failed to load the history'
  } finally {
    loading.value = false
  }
}

onMounted(load)

const STATUS: Record<string, string> = { success: 'Succeeded', failed: 'Failed', running: 'Running' }
</script>

<template>
  <Modal panel-class="w-full max-w-3xl" @close="emit('close')">
    <template #header>
      <h3 class="text-sm font-semibold text-foreground truncate">{{ title }}</h3>
    </template>

    <div class="px-5 py-4">
      <LoadingState v-if="loading" variant="compact" />
      <ErrorState v-else-if="error" :message="error" retry-label="Retry" compact @retry="load" />
      <EmptyState v-else-if="!runs.length" message="No run yet." />
      <div v-else class="overflow-x-auto rounded-xl border border-border">
        <Table class="w-full text-sm border-collapse">
          <TableHeader>
            <TableRow class="bg-muted border-b border-border text-muted-foreground text-xs uppercase tracking-caps">
              <TableHead class="text-left px-3 py-2 font-medium">Started</TableHead>
              <TableHead class="text-left px-3 py-2 font-medium">Duration</TableHead>
              <TableHead class="text-left px-3 py-2 font-medium">Status</TableHead>
              <TableHead v-if="kind === 'runs'" class="text-right px-3 py-2 font-medium">Added</TableHead>
              <TableHead v-if="kind === 'runs'" class="text-left px-3 py-2 font-medium">Snapshot</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody class="divide-y divide-border">
            <template v-for="(r, i) in runs" :key="r.runId ?? i">
              <TableRow>
                <TableCell class="px-3 py-2 text-xs text-foreground/80 whitespace-nowrap">{{ formatDateTime(r.start) }}</TableCell>
                <TableCell class="px-3 py-2 text-xs text-foreground/80 tabular-nums whitespace-nowrap">{{ durationLabel(r.start, r.end) || '-' }}</TableCell>
                <TableCell class="px-3 py-2 text-xs whitespace-nowrap">
                  <span :class="TONE_CLASS[runLabel(r).tone]">{{ STATUS[r.status] ?? r.status }}</span>
                  <Tip v-if="r.consistent === true" text="The apps were stopped during the run"><Badge variant="secondary" class="ml-2">Consistent</Badge></Tip>
                  <Tip v-else-if="r.consistent === false" text="An app could not be stopped during the run"><Badge variant="outline" class="bg-warning/10 text-warning ml-2">Not consistent</Badge></Tip>
                </TableCell>
                <TableCell v-if="kind === 'runs'" class="px-3 py-2 text-right text-xs text-foreground/80 tabular-nums whitespace-nowrap">{{ r.added !== undefined ? bytesLabel(r.added) : '-' }}</TableCell>
                <TableCell v-if="kind === 'runs'" class="px-3 py-2 font-mono text-2xs text-muted-foreground">{{ r.snapshotId ? r.snapshotId.slice(0, 8) : '-' }}</TableCell>
              </TableRow>
              <TableRow v-if="r.error || r.warnings?.length">
                <TableCell :colspan="kind === 'runs' ? 5 : 3" class="px-3 pb-2 pt-0">
                  <p v-if="r.error" class="status-text text-destructive break-words"><span class="status-tag">[ERR]</span> {{ r.error }}</p>
                  <p v-for="w in r.warnings ?? []" :key="w" class="status-text text-warning break-words"><span class="status-tag">[WARN]</span> {{ w }}</p>
                </TableCell>
              </TableRow>
            </template>
          </TableBody>
        </Table>
      </div>
    </div>
  </Modal>
</template>
