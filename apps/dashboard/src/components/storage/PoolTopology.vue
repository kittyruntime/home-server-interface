<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { DatabaseIcon, HardDriveIcon, PackageIcon } from '@lucide/vue'
import { topology, type TopoVdev } from './zfs-topology'

// A pool as a tree: the pool, its vdevs, their disks, each with its state and
// its read, write and checksum errors.
const props = defineProps<{ pool: { name: string; state: string; vdevs: TopoVdev[] } }>()
const { t } = useI18n()
const rows = computed(() => topology(props.pool))
const ICON = { pool: DatabaseIcon, vdev: PackageIcon, disk: HardDriveIcon }
const bad = (state: string) => state !== 'ONLINE'
</script>

<template>
  <ul class="space-y-1 text-sm" :aria-label="t('ui.storage.Zfs.topology')">
    <li v-for="(r, i) in rows" :key="i" class="flex items-center gap-2" :style="{ paddingLeft: `${r.depth * 1.25}rem` }">
      <component :is="ICON[r.kind]" class="size-4 shrink-0" :class="bad(r.state) ? 'text-warning' : 'text-engine-zfs'" aria-hidden="true" />
      <span class="truncate" :class="r.kind === 'disk' ? 'font-mono text-xs' : 'font-medium'">{{ r.label }}</span>
      <span v-if="r.kind === 'vdev' && r.type !== 'disk'" class="badge badge-ghost badge-xs">{{ r.type }}</span>
      <span v-if="bad(r.state)" class="text-xs text-warning">{{ t(`ui.storage.Zfs.state.${r.state}`, r.state) }}</span>
      <span v-if="r.errors" class="text-xs text-warning tabular-nums">{{ t('ui.storage.Zfs.errors', { n: r.errors }) }}</span>
    </li>
  </ul>
</template>
