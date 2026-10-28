<script setup lang="ts">
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { LOADING } from '../../lib/loading'
import LoadingState from '../ui/LoadingState.vue'
import { ref, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { Button } from '@/components/ui/button'

type Diag = Awaited<ReturnType<typeof trpc.sharing.diagnose.query>>
type ShareDiag = Diag['shares'][number]

const shares = ref<ShareDiag[]>([])
const loading = ref(true)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const d = await trpc.sharing.diagnose.query()
    shares.value = d.shares
  } catch (e: any) {
    error.value = e?.message ?? 'Diagnostics failed'
  } finally {
    loading.value = false
  }
}
onMounted(load)

function dirWritable(s: ShareDiag): boolean {
  return !!s.dir?.exists && s.dir.groupWritable && s.dir.setgid
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold text-foreground">Share diagnostics</h2>
        <p class="text-sm text-muted-foreground mt-0.5">
          Who can actually read/write, who is blocked and why, and the state of the directories.
        </p>
      </div>
      <Button variant="outline" size="sm" class="shrink-0" :disabled="loading" @click="load">Refresh</Button>
    </div>

    <LoadingState v-if="loading" variant="compact" :label="LOADING.analyzing" />
    <div v-else-if="error" role="alert" class="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{{ error }}</div>
    <div v-else-if="shares.length === 0" class="text-sm text-muted-foreground">No active shares.</div>

    <div v-else class="space-y-3">
      <Card v-for="s in shares" :key="s.id" class="block gap-0 py-0 overflow-hidden p-4 space-y-3">
        <!-- Header -->
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <span class="text-sm font-medium text-foreground">{{ s.name }}</span>
            <span class="block text-xs text-muted-foreground font-mono truncate">{{ s.path }}</span>
          </div>
          <Badge
            variant="secondary"
            :class="['shrink-0', !dirWritable(s) && 'bg-warning/15 text-warning']"
          >{{ dirWritable(s) ? 'Directory OK' : 'Directory not writable' }}</Badge>
        </div>

        <!-- Nobody can write -->
        <p v-if="s.writers.length === 0 && !s.readOnly" class="text-xs text-warning">
          ⚠ No account can write to this share.
        </p>

        <!-- Writers -->
        <div v-if="s.writers.length" class="space-y-1">
          <div class="eyebrow">Write</div>
          <div class="flex flex-wrap gap-1.5">
            <span v-for="w in s.writers" :key="w.linuxUsername"
              class="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg bg-muted border border-border">
              <span class="w-1.5 h-1.5 rounded-full" :class="w.hasSamba ? 'bg-success' : 'bg-destructive'" />
              {{ w.linuxUsername }}
              <span v-if="!w.hasSamba" class="text-destructive">· no Samba password</span>
            </span>
          </div>
        </div>

        <!-- Readers -->
        <div v-if="s.readers.length" class="space-y-1">
          <div class="eyebrow">Read-only</div>
          <div class="flex flex-wrap gap-1.5">
            <span v-for="r in s.readers" :key="r.linuxUsername"
              class="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg bg-muted border border-border text-foreground/80">
              <span class="w-1.5 h-1.5 rounded-full" :class="r.hasSamba ? 'bg-success' : 'bg-destructive'" />
              {{ r.linuxUsername }}
            </span>
          </div>
        </div>

        <!-- Excluded (permitted but unusable) -->
        <div v-if="s.excluded.length" class="space-y-1">
          <div class="eyebrow">Blocked</div>
          <div v-for="e in s.excluded" :key="e.username" class="text-xs text-warning">
            <span class="font-medium">{{ e.username }}</span>: {{ e.reason }}
          </div>
        </div>

        <!-- Guest note -->
        <p v-if="s.guestOk" class="text-2xs text-muted-foreground">Guest access enabled (read-only for unauthenticated users).</p>

        <!-- Dir detail -->
        <p v-if="s.dir" class="text-2xs text-muted-foreground font-mono">
          group {{ s.dir.group || '-' }} · mode {{ s.dir.mode }}<span v-if="!s.dir.exists"> · not found</span>
        </p>
      </Card>
    </div>
  </div>
</template>
