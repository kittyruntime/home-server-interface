<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { ref, watch } from 'vue'
import { trpc } from '../../lib/trpc'
import LoadingState from '../ui/LoadingState.vue'
import { actionLabel } from '../../lib/audit-labels'

const { t } = useI18n()

// Recent operations on one storage object (#40), from the audit log.
const props = defineProps<{ targets: string[]; arrays?: string[] }>()

type Entry = Awaited<ReturnType<typeof trpc.storage.activity.query>>[number]
const entries = ref<Entry[]>([])
const loading = ref(true)
const error   = ref('')
const open    = ref<Set<string>>(new Set())

const OP_LABELS: Record<string, string> = {
  'format': 'Format', 'mount': 'Mount', 'umount': 'Unmount',
  'part.init': 'New partition table', 'part.create': 'Create partition', 'part.delete': 'Delete partition',
  'pv.create': 'Create physical volume', 'vg.create': 'Create volume group', 'lv.create': 'Create logical volume',
  'lv.remove': 'Remove logical volume', 'vg.remove': 'Remove volume group',
  'raid.create': 'Create RAID array', 'raid.stop': 'Stop RAID array', 'raid.fail': 'Mark disk as failed',
  'raid.remove': 'Remove disk from array', 'raid.add': 'Add disk to array',
  'import.assemble': 'Import array', 'import.activate': 'Import volume group',
}
function label(e: Entry): string {
  if (e.op) return OP_LABELS[e.op] ?? e.op
  return actionLabel(e.action)
}
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

async function load() {
  loading.value = true
  error.value = ''
  try {
    entries.value = props.targets.length ? await trpc.storage.activity.query({ targets: props.targets.slice(0, 20), arrays: props.arrays }) : []
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not read the activity'
  } finally {
    loading.value = false
  }
}
watch(() => props.targets.join('\n'), load, { immediate: true })

function toggle(id: string) {
  const s = new Set(open.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  open.value = s
}
</script>

<template>
  <div>
    <LoadingState v-if="loading" variant="compact" />
    <p v-else-if="error" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ error }}</p>
    <p v-else-if="!entries.length" class="text-sm text-muted-foreground">{{ t('ui.storage.ActivityList.noRecordedOperationYet') }}</p>
    <ol v-else class="divide-y divide-border rounded-xl border border-border bg-card">
      <li v-for="e in entries" :key="e.id" class="px-4 py-2.5">
        <div class="flex items-center gap-3 text-sm">
          <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="e.success ? 'bg-success' : 'bg-destructive'" />
          <span class="flex-1 min-w-0 truncate text-foreground">{{ label(e) }}</span>
          <span class="text-xs text-muted-foreground shrink-0">{{ e.user ?? 'system' }} · {{ when(e.at) }}</span>
        </div>
        <Button variant="link" v-if="e.steps?.length" class="h-auto p-0 mt-1 ml-4.5 text-muted-foreground hover:text-foreground" :aria-expanded="open.has(e.id)" @click="toggle(e.id)">
          {{ open.has(e.id) ? 'Hide steps' : `${e.steps.length} ${e.steps.length === 1 ? 'step' : 'steps'}` }}
        </Button>
        <ol v-if="open.has(e.id)" class="mt-1.5 ml-4.5 space-y-1">
          <li v-for="(s, i) in e.steps" :key="i" class="flex items-start gap-2 text-xs">
            <span class="font-mono tabular-nums text-muted-foreground w-4 text-right shrink-0">{{ i + 1 }}</span>
            <span class="flex-1 text-foreground/80">{{ s.summary }}</span>
            <span class="shrink-0" :class="s.status === 'failed' ? 'text-destructive' : s.status === 'done' || s.status === 'started' ? 'text-muted-foreground' : 'text-warning'">{{ s.status }}</span>
          </li>
        </ol>
      </li>
    </ol>
  </div>
</template>
