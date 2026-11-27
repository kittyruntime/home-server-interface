<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import Modal from '../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { applyPlanned } from '../../lib/plan'
import { useToast } from '../../lib/toast'
import type { ZfsDataset } from './zfs-data'

// A new dataset inside a pool (parent, name, quota, compression), or the quota
// and compression of an existing one.
const props = defineProps<{ mode: 'create' | 'edit'; parents?: string[]; dataset?: ZfsDataset }>()
const emit = defineEmits<{ close: []; done: [] }>()
const { t } = useI18n()
const toast = useToast()

const GB = 1e9
const parent = ref(props.parents?.[0] ?? '')
const leaf = ref('')
const quotaGB = ref<number | ''>(props.dataset?.quota ? Math.round(props.dataset.quota / GB) : '')
const compression = ref<string>(props.mode === 'create' ? 'inherit' : (props.dataset?.compression ?? 'lz4'))

const fullName = computed(() => props.mode === 'create' ? `${parent.value}/${leaf.value}` : props.dataset!.name)
const leafError = computed(() => leaf.value && (!/^[A-Za-z0-9_.:-]{1,64}$/.test(leaf.value) || leaf.value === '.' || leaf.value === '..') ? t('ui.storage.ZfsDataset.badName') : '')
const ready = computed(() => props.mode === 'edit' || (!!parent.value && !!leaf.value && !leafError.value))
const quota = computed(() => (quotaGB.value === '' || quotaGB.value <= 0 ? 0 : Math.round(Number(quotaGB.value) * GB)))

async function submit() {
  try {
    if (props.mode === 'create') {
      await applyPlanned('zfs.dataset.create', { name: fullName.value, quota: quota.value, compression: compression.value }, {
        title: t('ui.storage.ZfsDataset.createTitle', { name: fullName.value }), actionLabel: t('ui.storage.ZfsDataset.create'),
      })
      toast.success(t('ui.storage.ZfsDataset.created', { name: fullName.value }))
    } else {
      await applyPlanned('zfs.dataset.set', { name: fullName.value, quota: quota.value, compression: compression.value }, {
        title: t('ui.storage.ZfsDataset.editTitle', { name: fullName.value }), actionLabel: t('ui.storage.ZfsDataset.save'),
      })
      toast.success(t('ui.storage.ZfsDataset.saved', { name: fullName.value }))
    }
    emit('done')
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('ui.storage.Zfs.failed'))
  }
}
</script>

<template>
  <Modal :label="mode === 'create' ? t('ui.storage.ZfsDataset.newHeading') : t('ui.storage.ZfsDataset.editHeading', { name: dataset?.name })" panel-class="w-full max-w-md" @close="emit('close')">
    <template #header>
      <div class="min-w-0">
        <h3 class="text-sm font-semibold text-base-content">{{ mode === 'create' ? t('ui.storage.ZfsDataset.newHeading') : t('ui.storage.ZfsDataset.editHeading', { name: dataset?.name }) }}</h3>
        <p class="mt-0.5 text-xs text-base-content/70">{{ t('ui.storage.ZfsDataset.subtitle') }}</p>
      </div>
    </template>
    <div class="p-5 space-y-4">
      <template v-if="mode === 'create'">
        <label class="block">
          <span class="text-sm font-medium">{{ t('ui.storage.ZfsDataset.inside') }}</span>
          <NativeSelect v-model="parent" class="mt-1 font-mono">
            <NativeSelectOption v-for="p in parents" :key="p" :value="p">{{ p }}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label class="block">
          <span class="text-sm font-medium">{{ t('ui.storage.ZfsDataset.name') }}</span>
          <Input v-model="leaf" class="mt-1 font-mono" placeholder="photos" maxlength="64" :aria-invalid="!!leafError" />
          <span v-if="leafError" class="mt-1 block text-xs text-error">{{ leafError }}</span>
          <span v-else-if="leaf" class="mt-1 block font-mono text-xs text-base-content/70">{{ fullName }}</span>
        </label>
      </template>
      <label class="block">
        <span class="text-sm font-medium">{{ t('ui.storage.ZfsDataset.quota') }}</span>
        <Input v-model.number="quotaGB" type="number" min="0" step="1" class="mt-1" :placeholder="t('ui.storage.ZfsDataset.noQuota')" />
        <span class="mt-1 block text-xs text-base-content/70">{{ t('ui.storage.ZfsDataset.quotaHelp') }}</span>
      </label>
      <label class="block">
        <span class="text-sm font-medium">{{ t('ui.storage.ZfsCreate.compression') }}</span>
        <NativeSelect v-model="compression" class="mt-1">
          <NativeSelectOption v-if="mode === 'create'" value="inherit">{{ t('ui.storage.ZfsDataset.inherit') }}</NativeSelectOption>
          <NativeSelectOption value="lz4">{{ t('ui.storage.ZfsCreate.lz4') }}</NativeSelectOption>
          <NativeSelectOption value="zstd">{{ t('ui.storage.ZfsCreate.zstd') }}</NativeSelectOption>
          <NativeSelectOption value="off">{{ t('ui.storage.ZfsCreate.off') }}</NativeSelectOption>
        </NativeSelect>
      </label>
      <div class="flex gap-2 pt-1">
        <Button variant="outline" class="flex-1 justify-center" @click="emit('close')">{{ t('ui.storage.PhysicalDisksSection.cancel') }}</Button>
        <Button class="flex-1 justify-center" :disabled="!ready" @click="submit">{{ t('ui.storage.ZfsCreate.review') }}</Button>
      </div>
    </div>
  </Modal>
</template>
