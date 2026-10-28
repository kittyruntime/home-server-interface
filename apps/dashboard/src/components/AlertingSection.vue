<script setup lang="ts">
import { Card } from '@/components/ui/card'
import { ref, computed, onMounted } from 'vue'
import { trpc } from '../lib/trpc'
import LoadingState from './ui/LoadingState.vue'
import ErrorState from './ui/ErrorState.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

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
    <h2 class="text-lg font-semibold text-foreground mb-1">Alert thresholds</h2>
    <p class="text-sm text-muted-foreground mb-6">
      Background health checks, sampled every 5 minutes. Active alerts are listed in Monitor &gt; Alerts.
    </p>

    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error" :message="error" retry-label="Retry" @retry="load" />

    <Card v-else class="block gap-0 py-0 overflow-hidden p-5 max-w-xl">
      <p class="eyebrow mb-4">Disk usage</p>
      <p class="text-xs text-muted-foreground mb-4">
        Each Place's filesystem is checked against these percentages. Doesn't apply to the
        RAID or S.M.A.R.T. checks, which alert on their own pass/fail state.
      </p>
      <div class="flex flex-wrap gap-6">
        <label class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Warning at</span>
          <div class="flex items-center gap-1.5">
            <Input
              v-model.number="form.diskUsageWarningPercent"
              type="number" min="1" max="99"
              class="w-16 px-2 py-1.5 text-sm tabular-nums"
             />
            <span class="text-sm text-muted-foreground">%</span>
          </div>
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Critical at</span>
          <div class="flex items-center gap-1.5">
            <Input
              v-model.number="form.diskUsageCriticalPercent"
              type="number" min="1" max="99"
              class="w-16 px-2 py-1.5 text-sm tabular-nums"
             />
            <span class="text-sm text-muted-foreground">%</span>
          </div>
        </label>
      </div>
      <p v-if="saveError" role="alert" class="mt-4 status-text text-destructive"><span class="status-tag">[ERR]</span> {{ saveError }}</p>
      <p v-else-if="saved && !dirty" class="text-xs text-success mt-4">Saved.</p>
      <div class="mt-4">
        <Button size="sm"
          :disabled="!dirty || saving"
          @click="saveThresholds"
        >{{ saving ? 'Saving…' : 'Save' }}</Button>
      </div>
    </Card>
  </div>
</template>
