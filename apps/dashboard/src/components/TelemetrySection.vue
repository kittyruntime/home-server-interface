<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { trpc } from '../lib/trpc'
import { useToast } from '../lib/toast'
import LoadingState from './ui/LoadingState.vue'
import ErrorState from './ui/ErrorState.vue'

type Status = Awaited<ReturnType<typeof trpc.telemetry.status.query>>

const toast = useToast()
const loading = ref(true)
const error = ref('')
const saving = ref(false)
const status = ref<Status | null>(null)

const payloadText = computed(() => status.value ? JSON.stringify(status.value.payload, null, 2) : '')

async function load() {
  loading.value = true
  error.value = ''
  try {
    status.value = await trpc.telemetry.status.query()
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load telemetry settings'
  } finally {
    loading.value = false
  }
}

async function setEnabled(enabled: boolean) {
  saving.value = true
  try {
    status.value = await trpc.telemetry.setEnabled.mutate({ enabled })
  } catch (e: any) {
    toast.error(e?.message ?? 'Failed to change telemetry')
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <h2 class="text-lg font-semibold text-foreground mb-1">Telemetry</h2>
    <p class="text-sm text-muted-foreground mb-6 max-w-xl">
      Once a day, HSI sends an anonymous heartbeat: its version, release channel and a hardware summary.
      No file names, users, addresses or settings. It helps decide which systems to support.
    </p>

    <LoadingState v-if="loading" />
    <ErrorState v-else-if="error" :message="error" retry-label="Retry" @retry="load" />

    <div v-else-if="status" class="space-y-4 max-w-xl">
      <Card class="flex flex-row items-center justify-between gap-4 px-4 py-3 shadow-none">
        <div class="min-w-0">
          <p class="text-sm text-foreground">Send the daily heartbeat</p>
          <p v-if="status.disabledBy === 'environment'" class="text-xs text-muted-foreground mt-0.5">
            Turned off on the server with <code class="font-mono">HSI_TELEMETRY_ENABLED</code>.
          </p>
        </div>
        <Switch
          :model-value="status.enabled"
          :disabled="saving || status.disabledBy === 'environment'"
          aria-label="Send the daily heartbeat"
          @update:model-value="setEnabled"
        />
      </Card>

      <div>
        <p class="eyebrow mb-1.5">What is sent</p>
        <p class="text-xs text-muted-foreground mb-2">
          To have this installation's data deleted, send its installation ID,
          <span class="font-mono text-foreground/80 select-all">{{ status.payload.installation_id }}</span>, with your request.
        </p>
        <pre class="max-h-96 overflow-auto rounded-lg border bg-muted p-3 font-mono text-2xs leading-relaxed text-foreground/80 select-text">{{ payloadText }}</pre>
      </div>
    </div>
  </div>
</template>
