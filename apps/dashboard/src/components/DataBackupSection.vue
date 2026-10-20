<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { trpc } from '../lib/trpc'
import { formatDateTime } from '../lib/format-date'
import LoadingState from './ui/LoadingState.vue'
import EmptyState from './ui/EmptyState.vue'

const plans = ref<Array<{ id: string; name: string; type: string; enabled: boolean; nextRun: string | null }>>([])
const loading = ref(true)
const error = ref('')

onMounted(async () => {
  try {
    plans.value = (await trpc.backup.status.query()).plans
  } catch (e) {
    error.value = e instanceof Error && e.message ? e.message : 'Failed to load the backup plans'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <section class="space-y-4">
    <h2 class="text-lg font-semibold text-[var(--c-text-1)]">Data backups</h2>
    <div v-if="error" role="alert" class="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{{ error }}</div>
    <LoadingState v-if="loading" variant="compact" />
    <EmptyState v-else-if="plans.length === 0" message="No backup plans." />
    <ul v-else class="space-y-2">
      <li v-for="p in plans" :key="p.id" class="rounded-xl border border-[var(--c-border)] bg-[var(--c-surface)] px-4 py-3 text-sm text-[var(--c-text-1)]">
        {{ p.name }} ({{ p.type }}){{ p.enabled && p.nextRun ? `, next run ${formatDateTime(p.nextRun)}` : '' }}
      </li>
    </ul>
  </section>
</template>
