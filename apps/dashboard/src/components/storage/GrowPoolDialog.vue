<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref } from 'vue'
import Modal from '../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { useToast } from '../../lib/toast'
import { fmtBytes } from './store'

// Grow a pool with free whole disks: a new group of the pool's layout, or
// one more disk in a mirror or raidz group.
const props = defineProps<{ pool: string; mode: 'add' | 'attach'; layout?: string; width?: number; vdev?: string }>()
const emit = defineEmits<{ close: []; done: [] }>()
const { t } = useI18n()
const toast = useToast()
const free = ref<Array<{ name: string; size: number; model: string; serial?: string }>>([])
const picked = ref<string[]>([])
onMounted(async () => {
  try { free.value = (await trpc.storage.volumes.overview.query()).freeDisks } catch { free.value = [] }
})
// A group takes exactly the pool's width (a stripe one or more); attach takes one.
const need = computed(() => (props.mode === 'attach' ? 1 : props.layout === 'stripe' ? 0 : props.width ?? 1))
const ready = computed(() => (need.value === 0 ? picked.value.length >= 1 : picked.value.length === need.value))
function toggle(name: string) {
  if (props.mode === 'attach') { picked.value = [name]; return }
  picked.value = picked.value.includes(name) ? picked.value.filter(n => n !== name) : [...picked.value, name]
}

async function grow() {
  try {
    if (props.mode === 'add') {
      await applyPlanned('zfs.pool.add', { pool: props.pool, disks: picked.value }, {
        title: t('ui.storage.ZfsGrow.addTitle', { name: props.pool }), actionLabel: t('ui.storage.ZfsGrow.add'), danger: true,
        notice: t('ui.storage.ZfsGrow.addNotice'), acknowledge: t('ui.storage.ZfsGrow.addAck'),
      })
    } else {
      await applyPlanned('zfs.pool.attach', { pool: props.pool, vdev: props.vdev, disk: picked.value[0] }, {
        title: t('ui.storage.ZfsGrow.attachTitle', { vdev: props.vdev, name: props.pool }), actionLabel: t('ui.storage.ZfsGrow.attach'), danger: true,
      })
    }
    toast.success(t('ui.storage.ZfsGrow.grown', { name: props.pool }))
    emit('done')
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('ui.storage.Zfs.failed'))
  }
}
const heading = computed(() => (props.mode === 'add' ? t('ui.storage.ZfsGrow.addHeading') : t('ui.storage.ZfsGrow.attachHeading', { vdev: props.vdev })))
</script>

<template>
  <Modal :label="heading" panel-class="w-full max-w-md" @close="emit('close')">
    <div class="px-5 py-4 border-b border-base-300">
      <h3 class="font-semibold text-base-content">{{ heading }}</h3>
      <p class="mt-0.5 text-xs text-base-content/70">
        <template v-if="mode === 'attach'">{{ vdev?.startsWith('mirror') ? t('ui.storage.ZfsGrow.attachMirrorHint') : t('ui.storage.ZfsGrow.attachRaidzHint') }}</template>
        <template v-else-if="need === 0">{{ t('ui.storage.ZfsGrow.addStripeHint') }}</template>
        <template v-else>{{ t('ui.storage.ZfsGrow.addHint', { layout, n: need }) }}</template>
      </p>
    </div>
    <div class="p-5 space-y-3">
      <p v-if="!free.length" class="text-sm text-base-content/70">{{ t('ui.storage.ZfsCreate.noFreeDisk') }}</p>
      <label v-for="d in free" :key="d.name" class="flex items-center gap-2 text-sm">
        <input :type="mode === 'attach' ? 'radio' : 'checkbox'" name="disk" :checked="picked.includes(d.name)" :class="mode === 'attach' ? 'radio radio-xs' : 'checkbox checkbox-xs'" @change="toggle(d.name)">
        <span class="font-mono">{{ d.name }}</span>
        <span class="text-xs text-base-content/70">{{ fmtBytes(d.size) }} · {{ d.model }}</span>
      </label>
      <p v-if="need > 1" class="text-xs text-base-content/70 tabular-nums">{{ t('ui.storage.ZfsGrow.picked', { n: picked.length, of: need }) }}</p>
      <div class="flex gap-2 pt-1">
        <Button variant="outline" class="flex-1 justify-center" @click="emit('close')">{{ t('ui.storage.PhysicalDisksSection.cancel') }}</Button>
        <Button class="flex-1 justify-center" :disabled="!ready" @click="grow">{{ t('ui.storage.ZfsCreate.review') }}</Button>
      </div>
    </div>
  </Modal>
</template>
