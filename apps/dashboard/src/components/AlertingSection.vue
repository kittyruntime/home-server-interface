<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import LoadingState from './ui/LoadingState.vue'
import ErrorState from './ui/ErrorState.vue'

type Thresholds = { diskUsageWarningPercent: number; diskUsageCriticalPercent: number }

const loading = ref(true)
const error   = ref('')
const thresholds = ref<Thresholds>({ diskUsageWarningPercent: 80, diskUsageCriticalPercent: 90 })

const form = ref<Thresholds>({ ...thresholds.value })
const saving = ref(false)
const saveError = ref('')
const saved = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const t = await trpc.alert.thresholds.query()
    thresholds.value = t
    form.value = { ...t }
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load thresholds'
  } finally {
    loading.value = false
  }
}

async function saveThresholds() {
  saveError.value = ''
  saved.value = false
  if (form.value.diskUsageCriticalPercent <= form.value.diskUsageWarningPercent) {
    saveError.value = 'Critical must be higher than warning'
    return
  }
  saving.value = true
  try {
    thresholds.value = await trpc.alert.updateThresholds.mutate(form.value)
    saved.value = true
  } catch (e: any) {
    saveError.value = e?.message ?? 'Failed to save thresholds'
  } finally {
    saving.value = false
  }
}

const dirty = computed(() =>
  form.value.diskUsageWarningPercent !== thresholds.value.diskUsageWarningPercent ||
  form.value.diskUsageCriticalPercent !== thresholds.value.diskUsageCriticalPercent
)

onMounted(load)
</script>

<template>
  <div>
    <h2 class="text-base font-semibold text-[var(--c-text-1)] mb-1">Alerts</h2>
    <p class="text-sm text-[var(--c-text-3)] mb-6">
      Background health checks, sampled every 5 minutes. Active alerts are listed in Monitor &gt; Alerts.
    </p>

    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error" :message="error" retry-label="Retry" @retry="load" />

    <div v-else class="panel-card p-5 max-w-xl">
      <p class="eyebrow mb-4">Disk usage</p>
      <p class="text-xs text-[var(--c-text-3)] mb-4">
        Each Place's filesystem is checked against these percentages. Doesn't apply to the
        RAID or S.M.A.R.T. checks, which alert on their own pass/fail state.
      </p>
      <div class="flex flex-wrap gap-6">
        <label class="flex flex-col gap-1.5">
          <span class="text-xs text-[var(--c-text-3)]">Warning at</span>
          <div class="flex items-center gap-1.5">
            <input
              v-model.number="form.diskUsageWarningPercent"
              type="number" min="1" max="99"
              class="w-16 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] px-2 py-1.5 text-sm text-[var(--c-text-1)] tabular-nums"
            >
            <span class="text-sm text-[var(--c-text-3)]">%</span>
          </div>
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="text-xs text-[var(--c-text-3)]">Critical at</span>
          <div class="flex items-center gap-1.5">
            <input
              v-model.number="form.diskUsageCriticalPercent"
              type="number" min="1" max="99"
              class="w-16 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface-deep)] px-2 py-1.5 text-sm text-[var(--c-text-1)] tabular-nums"
            >
            <span class="text-sm text-[var(--c-text-3)]">%</span>
          </div>
        </label>
      </div>
      <p v-if="saveError" class="text-xs text-[var(--c-danger)] mt-4">{{ saveError }}</p>
      <p v-else-if="saved && !dirty" class="text-xs text-[var(--c-success)] mt-4">Saved.</p>
      <div class="mt-4">
        <button
          class="btn btn-sm btn-primary"
          :disabled="!dirty || saving"
          @click="saveThresholds"
        >{{ saving ? 'Saving…' : 'Save' }}</button>
      </div>
    </div>
  </div>
</template>
