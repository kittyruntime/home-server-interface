<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Alert } from '@/components/ui/alert'
import { ref, computed, watch } from 'vue'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { driftTitle, reapplyRequest } from './description'
import { Button } from '@/components/ui/button'

const { t } = useI18n()

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
        title: t('uis.storage.DescriptionCard.reapplyTheDescriptionOf', { p0: s.mountPoint }), actionLabel: t('uis.storage.DescriptionCard.reapply'), acknowledge: r.acknowledge,
      })
    } else {
      await applyPlanned('storage.accept', { mountPoint: s.mountPoint }, {
        title: t('uis.storage.DescriptionCard.describeAsItIsNow', { p0: s.mountPoint }), actionLabel: t('uis.storage.DescriptionCard.acceptCurrentState'),
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
  <Alert variant="warning" v-if="status && status.items.length" class="block space-y-2" role="note">
    <h3 class="font-semibold text-foreground"><span v-if="titled" class="font-mono">{{ mountPoint }}</span><template v-if="titled"> {{ t('ui.storage.DescriptionCard.differsFromItsDescription') }}</template><template v-else>{{ t('ui.storage.DescriptionCard.differsFromItsDescription2') }}</template></h3>
    <p class="text-foreground/80">{{ driftTitle(status.items) }}</p>
    <ul v-if="status.items.length > 1" class="list-disc pl-5 space-y-0.5 text-foreground/80">
      <li v-for="(i, n) in status.items" :key="n">{{ i.text }}</li>
    </ul>
    <p class="text-xs text-muted-foreground">{{ t('ui.storage.DescriptionCard.describedIn') }} <span class="font-mono">{{ status.file }}</span>{{ t('ui.storage.DescriptionCard.hsiDoesNotChangeAnything') }}</p>
    <p v-if="err" role="alert" class="status-text text-destructive"><span class="status-tag">[ERR]</span> {{ err }}</p>
    <div v-if="status.mountPoint" class="flex flex-wrap gap-2 pt-1">
      <Button variant="outline" size="sm" v-if="!unreadable" :disabled="busy" @click="run('reapply')">{{ t('ui.storage.DescriptionCard.reapply') }}</Button>
      <Button variant="outline" size="sm" :disabled="busy" @click="run('accept')">{{ t('ui.storage.DescriptionCard.acceptCurrentState') }}</Button>
    </div>
  </Alert>
  <p v-else-if="status" class="text-xs text-muted-foreground">{{ t('ui.storage.DescriptionCard.describedIn') }} <span class="font-mono">{{ status.file }}</span></p>
</template>
