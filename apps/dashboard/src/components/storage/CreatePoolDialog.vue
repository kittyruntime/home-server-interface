<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import Modal from '../ui/Modal.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import TermHelp from './TermHelp.vue'
import { applyPlanned } from '../../lib/plan'
import { useToast } from '../../lib/toast'
import { fmtBytes } from './store'
import { LAYOUT_MIN, poolCapacity, type PoolLayout } from './pool-summary'

// A new ZFS pool from free whole disks: its name (mounted on /srv/<name>), its
// layout with what it holds and survives, its disks and its compression.
const props = defineProps<{ freeDisks: Array<{ name: string; size: number; model: string; serial?: string }>; taken: string[] }>()
const emit = defineEmits<{ close: []; created: [name: string] }>()
const { t } = useI18n()
const toast = useToast()

const name = ref('')
const layout = ref<PoolLayout>('mirror')
const picked = ref<Set<string>>(new Set(props.freeDisks.slice(0, 2).map(d => d.name)))
const compression = ref<'lz4' | 'zstd' | 'off'>('lz4')
const LAYOUTS: PoolLayout[] = ['stripe', 'mirror', 'raidz1', 'raidz2', 'raidz3']
const SYSTEM = new Set(['bin', 'boot', 'dev', 'etc', 'home', 'lib', 'media', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var'])

const sizes = computed(() => props.freeDisks.filter(d => picked.value.has(d.name)).map(d => d.size))
const cap = computed(() => poolCapacity(layout.value, sizes.value))
const nameError = computed(() => {
  if (!name.value) return ''
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(name.value) || SYSTEM.has(name.value)) return t('ui.storage.ZfsCreate.badName')
  if (props.taken.includes(name.value)) return t('ui.storage.ZfsCreate.nameTaken')
  return ''
})
const ready = computed(() => !!name.value && !nameError.value && cap.value.enough)

function toggle(n: string) {
  const s = new Set(picked.value)
  if (s.has(n)) s.delete(n)
  else s.add(n)
  picked.value = s
}

async function create() {
  const disks = [...picked.value]
  try {
    await applyPlanned('zfs.pool.create', { name: name.value, layout: layout.value, disks, compression: compression.value }, {
      title: t('ui.storage.ZfsCreate.title', { name: name.value }), actionLabel: t('ui.storage.ZfsCreate.create'), danger: true,
      notice: t('ui.storage.ZfsCreate.erases', { disks: disks.join(', ') }),
    })
    toast.success(t('ui.storage.ZfsCreate.created', { name: name.value }))
    emit('created', name.value)
  } catch (e: any) {
    if (e?.message !== '') toast.error(e?.message ?? t('ui.storage.Zfs.failed'))
  }
}
</script>

<template>
  <Modal :label="t('ui.storage.ZfsCreate.heading')" panel-class="w-full max-w-lg" @close="emit('close')">
    <div class="px-5 py-4 border-b border-base-300">
      <h3 class="font-semibold text-base-content">{{ t('ui.storage.ZfsCreate.heading') }}</h3>
      <p class="mt-0.5 text-xs text-base-content/70">{{ t('ui.storage.ZfsCreate.subtitle') }}</p>
    </div>
    <div class="p-5 space-y-5">
      <label class="block">
        <span class="text-sm font-medium">{{ t('ui.storage.ZfsCreate.name') }}</span>
        <Input v-model="name" class="mt-1 font-mono" placeholder="tank" maxlength="64" :aria-invalid="!!nameError" />
        <span v-if="nameError" class="mt-1 block text-xs text-error">{{ nameError }}</span>
        <span v-else-if="name" class="mt-1 block text-xs text-base-content/70">{{ t('ui.storage.ZfsCreate.mountedOn', { mp: `/srv/${name}` }) }}</span>
      </label>

      <fieldset>
        <legend class="flex items-center gap-1.5 text-sm font-medium">{{ t('ui.storage.ZfsCreate.disks') }}</legend>
        <p v-if="!freeDisks.length" class="mt-1 text-xs text-base-content/70">{{ t('ui.storage.ZfsCreate.noFreeDisk') }}</p>
        <div v-else class="mt-2 space-y-1.5">
          <label v-for="d in freeDisks" :key="d.name" class="flex items-center gap-2 text-sm">
            <Checkbox :model-value="picked.has(d.name)" @update:model-value="toggle(d.name)" />
            <span class="font-mono">{{ d.name }}</span>
            <span class="text-xs text-base-content/70">{{ fmtBytes(d.size) }} · {{ d.model }}<template v-if="d.serial"> · {{ d.serial }}</template></span>
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend class="flex items-center gap-1.5 text-sm font-medium">{{ t('ui.storage.ZfsCreate.layout') }}<TermHelp term="raidz" /></legend>
        <div class="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <label v-for="l in LAYOUTS" :key="l" class="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm"
            :class="[layout === l ? 'border-engine-zfs bg-engine-zfs/5' : 'border-base-300', sizes.length < LAYOUT_MIN[l] ? 'opacity-50' : '']">
            <input v-model="layout" type="radio" name="layout" :value="l" class="radio radio-xs mt-0.5" :disabled="sizes.length < LAYOUT_MIN[l]">
            <span>
              <span class="block font-medium">{{ t(`ui.storage.ZfsCreate.layouts.${l}`) }}</span>
              <span class="block text-xs text-base-content/70">{{ t(`ui.storage.ZfsCreate.layoutHelp.${l}`) }}</span>
            </span>
          </label>
        </div>
        <p class="mt-2 text-xs" :class="cap.enough ? 'text-base-content/80' : 'text-warning'">
          <template v-if="cap.enough">{{ t('ui.storage.ZfsCreate.capacity', { usable: fmtBytes(cap.usable), n: cap.tolerates }, cap.tolerates) }}</template>
          <template v-else>{{ t('ui.storage.ZfsCreate.needs', { n: LAYOUT_MIN[layout] }) }}</template>
        </p>
      </fieldset>

      <label class="block">
        <span class="text-sm font-medium">{{ t('ui.storage.ZfsCreate.compression') }}</span>
        <NativeSelect v-model="compression" class="mt-1">
          <NativeSelectOption value="lz4">{{ t('ui.storage.ZfsCreate.lz4') }}</NativeSelectOption>
          <NativeSelectOption value="zstd">{{ t('ui.storage.ZfsCreate.zstd') }}</NativeSelectOption>
          <NativeSelectOption value="off">{{ t('ui.storage.ZfsCreate.off') }}</NativeSelectOption>
        </NativeSelect>
      </label>

      <div class="flex gap-2 pt-1">
        <Button variant="outline" class="flex-1 justify-center" @click="emit('close')">{{ t('ui.storage.PhysicalDisksSection.cancel') }}</Button>
        <Button class="flex-1 justify-center" :disabled="!ready" @click="create">{{ t('ui.storage.ZfsCreate.review') }}</Button>
      </div>
    </div>
  </Modal>
</template>
