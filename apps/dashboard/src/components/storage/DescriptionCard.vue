<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { driftTitle, reapplyRequest } from './description'

/* Storage description (#37) of one volume: where it is described and, when
   the server no longer matches, what differs, with Reapply and Accept. */
const props = defineProps<{ mountPoint: string; titled?: boolean }>()
const emit = defineEmits<{ changed: [] }>()

type Status = Awaited<ReturnType<typeof trpc.storage.volumes.descriptions.query>>[number]
const status = ref<Status | null>(null)
const busy = ref(false)
// A file broken by a hand edit cannot be reapplied, only written again.
const unreadable = computed(() => status.value?.items.some(i => i.kind === 'unreadable') ?? false)
const err = ref('')

async function load() {
  try {
    const list = await trpc.storage.volumes.descriptions.query()
    status.value = list.find(s => s.mountPoint === props.mountPoint) ?? null
  } catch { status.value = null }
}
watch(() => props.mountPoint, load, { immediate: true })

async function run(kind: 'reapply' | 'accept') {
  const s = status.value
  if (!s) return
  busy.value = true
  err.value = ''
  try {
    if (kind === 'reapply') {
      const r = reapplyRequest(s.mountPoint, s.items)
      await applyPlanned('storage.reapply', r.input, {
        title: `Reapply the description of ${s.mountPoint}`, actionLabel: 'Reapply', acknowledge: r.acknowledge,
      })
    } else {
      await applyPlanned('storage.accept', { mountPoint: s.mountPoint }, {
        title: `Describe ${s.mountPoint} as it is now`, actionLabel: 'Accept current state',
      })
    }
    await load()
    emit('changed')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

defineExpose({ load })
</script>

<template>
  <div v-if="status && status.items.length" class="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm space-y-2">
    <h3 class="font-semibold text-[var(--c-text-1)]"><span v-if="titled" class="font-mono">{{ mountPoint }}</span><template v-if="titled"> differs from its description</template><template v-else>Differs from its description</template></h3>
    <p class="text-[var(--c-text-2)]">{{ driftTitle(status.items) }}</p>
    <ul v-if="status.items.length > 1" class="list-disc pl-5 space-y-0.5 text-[var(--c-text-2)]">
      <li v-for="(i, n) in status.items" :key="n">{{ i.text }}</li>
    </ul>
    <p class="text-xs text-[var(--c-text-3)]">Described in <span class="font-mono">{{ status.file }}</span>. HSI does not change anything on its own.</p>
    <p v-if="err" role="alert" class="status-text text-danger"><span class="status-tag">[ERR]</span> {{ err }}</p>
    <div v-if="status.mountPoint" class="flex flex-wrap gap-2 pt-1">
      <button v-if="!unreadable" class="btn btn-outline btn-sm" :disabled="busy" @click="run('reapply')">Reapply…</button>
      <button class="btn btn-outline btn-sm" :disabled="busy" @click="run('accept')">Accept current state…</button>
    </div>
  </div>
  <p v-else-if="status" class="text-xs text-[var(--c-text-3)]">Described in <span class="font-mono">{{ status.file }}</span></p>
</template>
