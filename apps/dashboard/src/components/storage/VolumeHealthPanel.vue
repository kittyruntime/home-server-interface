<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { trpc } from '../../lib/trpc'
import { useNotifications } from '../../lib/notifications'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

// HSI data volumes (#3): state, what is blocked while one is unusable, and the
// Resume action once it is back.

type Volume = Awaited<ReturnType<typeof trpc.storage.volumes.list.query>>[number]

const volumes = ref<Volume[]>([])
const { track } = useNotifications()
const resuming = ref<string | null>(null)

async function refresh() {
  try {
    volumes.value = await trpc.storage.volumes.list.query()
  } catch {
    volumes.value = []
  }
}
onMounted(refresh)
defineExpose({ refresh })

const STATE: Record<string, { label: string; cls: string }> = {
  ok:       { label: 'Mounted',      cls: 'border-transparent bg-success/10 text-success' },
  missing:  { label: 'Missing',      cls: 'border-transparent bg-destructive/10 text-destructive' },
  wrong:    { label: 'Wrong volume', cls: 'border-transparent bg-destructive/10 text-destructive' },
  readonly: { label: 'Read-only',    cls: 'border-transparent bg-warning/10 text-warning' },
  unmounted: { label: 'Unmounted',   cls: '' },
}

function since(d: string | Date): string {
  return new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

async function resume(mp: string) {
  resuming.value = mp
  try {
    await track(`Resuming ${mp}`, () => trpc.storage.volumes.resume.mutate({ mountPoint: mp }))
  } catch { /* shown by track */ } finally {
    resuming.value = null
    await refresh()
  }
}
</script>

<template>
  <section v-if="volumes.length" class="mb-8">
    <h3 class="text-sm font-semibold text-foreground mb-1">Data volumes</h3>
    <p class="text-xs text-muted-foreground mb-3">
      Volumes mounted by HSI. While one is unusable, the apps, shares, backups and file writes that use it are blocked, so nothing is written to the system disk instead.
    </p>
    <ul class="space-y-2">
      <li v-for="v in volumes" :key="v.mountPoint" class="rounded-xl border border-border bg-card px-4 py-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-mono text-xs text-foreground">{{ v.mountPoint }}</span>
          <Badge variant="secondary" :class="STATE[v.state]?.cls">{{ STATE[v.state]?.label ?? v.state }}</Badge>
          <Badge variant="outline" v-if="v.hold?.status === 'blocked'" class="bg-destructive/10 text-destructive">Blocked</Badge>
        </div>
        <p v-if="v.guardError" class="mt-1 text-2xs text-warning">Not protected against writes while unmounted: {{ v.guardError }}</p>

        <p v-if="v.hold?.status === 'blocked'" class="mt-2 text-xs text-foreground/80">
          Blocked since {{ since(v.hold.since) }}: apps using it are stopped, its shares are unavailable, backups and file writes are refused.
        </p>

        <div v-if="v.hold?.status === 'back'" class="mt-2 rounded-lg border border-border bg-muted p-3 space-y-2">
          <p class="text-xs text-foreground font-medium">Volume {{ v.mountPoint }} is back.</p>
          <p class="text-xs text-foreground/80">
            Check the disk (SMART, RAID state) before putting it back under load.
            <template v-if="v.hold.stoppedApps.length">Apps to restart: <span class="font-mono">{{ v.hold.stoppedApps.join(', ') }}</span>.</template>
          </p>
          <p v-if="v.hold.strayFiles" class="text-xs text-warning">
            Files were written to the system disk under {{ v.mountPoint }} before it was protected. To reach them, unmount the volume and run <span class="font-mono">chattr -i {{ v.mountPoint }}</span>.
          </p>
          <Button size="sm" :disabled="resuming === v.mountPoint" @click="resume(v.mountPoint)">
            {{ resuming === v.mountPoint ? 'Resuming…' : 'Resume' }}
          </Button>
        </div>
      </li>
    </ul>
  </section>
</template>
