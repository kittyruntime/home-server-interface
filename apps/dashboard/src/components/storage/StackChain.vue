<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import type { Component } from 'vue'
import { ChevronRightIcon, FolderIcon, HardDriveIcon, LayersIcon, PackageIcon, Rows3Icon } from '@lucide/vue'
import { chainOf, type ChainStep, type StackLayer } from './stack-chain'

// How a volume is built, from its disks to its folder (LVM tab).
const props = defineProps<{ volume: { stack: StackLayer[]; mountPoint?: string; fstype?: string } }>()
const { t } = useI18n()

const steps = computed(() => chainOf(props.volume))
const singleDisk = computed(() => steps.value.length > 0 && !steps.value.some(s => s.kind === 'array' || s.kind === 'vg'))
const ICON: Record<ChainStep['kind'], Component> = {
  disks: HardDriveIcon, array: PackageIcon, vg: Rows3Icon, filesystem: LayersIcon, mount: FolderIcon,
}
</script>

<template>
  <ol v-if="steps.length" class="flex flex-wrap items-center gap-1 text-2xs text-base-content/80" :aria-label="t('ui.storage.StackChain.howItIsBuilt')">
    <li v-for="(s, i) in steps" :key="s.kind" class="inline-flex items-center gap-1">
      <ChevronRightIcon v-if="i > 0" class="size-3 text-base-content/50" aria-hidden="true" />
      <span class="inline-flex items-center gap-1 rounded-md bg-base-200 px-1.5 py-0.5">
        <component :is="ICON[s.kind]" class="size-3 text-secondary" aria-hidden="true" />
        <span class="sr-only">{{ t(`ui.storage.StackChain.kind.${s.kind}`) }}</span>
        <span class="font-mono">{{ s.names.join(' + ') }}</span>
      </span>
    </li>
    <li v-if="singleDisk" class="ml-1"><span class="badge badge-ghost badge-xs">{{ t('ui.storage.StackChain.singleDisk') }}</span></li>
  </ol>
</template>
