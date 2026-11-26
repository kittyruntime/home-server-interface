<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { onMounted, ref } from 'vue'
import Modal from '../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { trpc } from '../../lib/trpc'
import { applyPlanned } from '../../lib/plan'
import { useToast } from '../../lib/toast'
import { fmtBytes } from './store'

// Replace a disk of a pool with a free whole disk; ZFS then resilvers it.
const props = defineProps<{ pool: string; leaf: string }>()
const emit = defineEmits<{ close: []; done: [] }>()
const { t } = useI18n()
const toast = useToast()
const free = ref<Array<{ name: string; size: number; model: string; serial?: string }>>([])
const picked = ref('')
onMounted(async () => {
  try { free.value = (await trpc.storage.volumes.overview.query()).freeDisks } catch { free.value = [] }
  picked.value = free.value[0]?.name ?? ''
})

async function replace() {
  try {
    await applyPlanned('zfs.replace', { pool: props.pool, leaf: props.leaf, disk: picked.value }, {
      title: t('ui.storage.ZfsRepair.replaceTitle', { leaf: props.leaf, pool: props.pool }), actionLabel: t('ui.storage.ZfsRepair.replace'),
      danger: true, notice: t('ui.storage.ZfsRepair.replaceNotice', { disk: picked.value }),
    })
    toast.success(t('ui.storage.ZfsRepair.replaced', { pool: props.pool }))
    emit('done')
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('ui.storage.Zfs.failed'))
  }
}
</script>

<template>
  <Modal :label="t('ui.storage.ZfsRepair.replaceHeading')" panel-class="w-full max-w-md" @close="emit('close')">
    <div class="px-5 py-4 border-b border-base-300">
      <h3 class="font-semibold text-base-content">{{ t('ui.storage.ZfsRepair.replaceHeading') }}</h3>
      <p class="mt-0.5 break-all text-xs text-base-content/70">{{ t('ui.storage.ZfsRepair.replaceSubtitle', { leaf, pool }) }}</p>
    </div>
    <div class="p-5 space-y-3">
      <p v-if="!free.length" class="text-sm text-base-content/70">{{ t('ui.storage.ZfsCreate.noFreeDisk') }}</p>
      <label v-for="d in free" :key="d.name" class="flex items-center gap-2 text-sm">
        <input v-model="picked" type="radio" name="disk" :value="d.name" class="radio radio-xs">
        <span class="font-mono">{{ d.name }}</span>
        <span class="text-xs text-base-content/70">{{ fmtBytes(d.size) }} · {{ d.model }}<template v-if="d.serial"> · {{ d.serial }}</template></span>
      </label>
      <p class="text-xs text-base-content/70">{{ t('ui.storage.ZfsRepair.sizeHint') }}</p>
      <div class="flex gap-2 pt-1">
        <Button variant="outline" class="flex-1 justify-center" @click="emit('close')">{{ t('ui.storage.PhysicalDisksSection.cancel') }}</Button>
        <Button class="flex-1 justify-center" :disabled="!picked" @click="replace">{{ t('ui.storage.ZfsCreate.review') }}</Button>
      </div>
    </div>
  </Modal>
</template>
