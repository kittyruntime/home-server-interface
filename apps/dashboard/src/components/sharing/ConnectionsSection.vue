<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { trpc } from '../../lib/trpc'

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

    <div v-if="loading" class="text-sm text-[var(--c-text-3)]">Loading…</div>

    <div v-else-if="connections.length === 0" class="panel-card bg-[var(--c-surface)] p-6 text-sm text-[var(--c-text-3)]">
      No active SMB connections.
    </div>

    <div v-else class="panel-card bg-[var(--c-surface)]">
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
</template>
