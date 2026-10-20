<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { trpc } from '../../lib/trpc'
import { formatDateTime } from '../../lib/format-date'
import { bytesLabel, durationLabel, runLabel, TONE_CLASS } from '../../lib/backup'
import Modal from '../ui/Modal.vue'
import LoadingState from '../ui/LoadingState.vue'
import ErrorState from '../ui/ErrorState.vue'
import EmptyState from '../ui/EmptyState.vue'

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
      <h3 class="text-sm font-semibold text-[var(--c-text-1)] truncate">{{ title }}</h3>
    </template>

    <div class="px-5 py-4">
      <LoadingState v-if="loading" variant="compact" />
      <ErrorState v-else-if="error" :message="error" retry-label="Retry" compact @retry="load" />
      <EmptyState v-else-if="!runs.length" message="No run yet." />
      <div v-else class="overflow-x-auto rounded-xl border border-[var(--c-border)]">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="bg-[var(--c-surface-deep)] border-b border-[var(--c-border)] text-[var(--c-text-3)] text-xs uppercase tracking-caps">
              <th class="text-left px-3 py-2 font-medium">Started</th>
              <th class="text-left px-3 py-2 font-medium">Duration</th>
              <th class="text-left px-3 py-2 font-medium">Status</th>
              <th v-if="kind === 'runs'" class="text-right px-3 py-2 font-medium">Added</th>
              <th v-if="kind === 'runs'" class="text-left px-3 py-2 font-medium">Snapshot</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--c-border)]">
            <template v-for="(r, i) in runs" :key="r.runId ?? i">
              <tr>
                <td class="px-3 py-2 text-xs text-[var(--c-text-2)] whitespace-nowrap">{{ formatDateTime(r.start) }}</td>
                <td class="px-3 py-2 text-xs text-[var(--c-text-2)] tabular-nums whitespace-nowrap">{{ durationLabel(r.start, r.end) || '-' }}</td>
                <td class="px-3 py-2 text-xs whitespace-nowrap">
                  <span :class="TONE_CLASS[runLabel(r).tone]">{{ STATUS[r.status] ?? r.status }}</span>
                  <span v-if="r.consistent === true" class="badge badge-muted ml-2" title="The apps were stopped during the run">Consistent</span>
                  <span v-else-if="r.consistent === false" class="badge bg-warning/10 text-warning ml-2" title="An app could not be stopped during the run">Not consistent</span>
                </td>
                <td v-if="kind === 'runs'" class="px-3 py-2 text-right text-xs text-[var(--c-text-2)] tabular-nums whitespace-nowrap">{{ r.added !== undefined ? bytesLabel(r.added) : '-' }}</td>
                <td v-if="kind === 'runs'" class="px-3 py-2 font-mono text-2xs text-[var(--c-text-3)]">{{ r.snapshotId ? r.snapshotId.slice(0, 8) : '-' }}</td>
              </tr>
              <tr v-if="r.error || r.warnings?.length">
                <td :colspan="kind === 'runs' ? 5 : 3" class="px-3 pb-2 pt-0">
                  <p v-if="r.error" class="status-text text-danger break-words"><span class="status-tag">[ERR]</span> {{ r.error }}</p>
                  <p v-for="w in r.warnings ?? []" :key="w" class="status-text text-warning break-words"><span class="status-tag">[WARN]</span> {{ w }}</p>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>
  </Modal>
</template>
