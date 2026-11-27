<script setup lang="ts">
import PhysicalDisksSection from './PhysicalDisksSection.vue'
import PartitionsSection from './PartitionsSection.vue'
import type { StorageLocation, StorageSection } from '../../lib/storage-nav'

// Disks: the hardware first, then the tools for the disks nothing uses
// (partition table, partitions, format, mount). Disks in use never show there.
const emit = defineEmits<{
  open: [disk: string]
  navigate: [target: StorageSection | StorageLocation]
  create: [kind: 'raid' | 'lvm' | 'volume', devices: string[]]
}>()
</script>

<template>
  <div>
    <PhysicalDisksSection @open="n => emit('open', n)" @navigate="l => emit('navigate', l)" @create="(k, d) => emit('create', k, d)" />
    <div class="mt-10 border-t border-base-300 pt-6">
      <PartitionsSection @navigate="l => emit('navigate', l)" />
    </div>
  </div>
</template>
