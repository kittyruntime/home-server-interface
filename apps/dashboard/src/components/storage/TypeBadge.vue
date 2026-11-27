<script setup lang="ts">
// The type of a pool or a volume, as a small tag: mdadm, LVM, ZFS, or plain.
defineProps<{ type: 'md' | 'lvm' | 'zfs' | 'plain' }>()
const LABEL = { md: 'mdadm', lvm: 'LVM', zfs: 'ZFS', plain: '' } as const
</script>

<template>
  <span v-if="type !== 'plain'" class="type-badge rounded-sm px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-caps"
    :class="`type-${type}`">{{ LABEL[type] }}</span>
</template>

<style scoped>
.type-badge { line-height: 1.2; }
.type-md { background: color-mix(in oklab, var(--color-engine-md) 18%, transparent); color: var(--color-engine-md); }
.type-lvm { background: color-mix(in oklab, var(--color-engine-lvm) 18%, transparent); color: var(--color-engine-lvm); }
.type-zfs { background: color-mix(in oklab, var(--color-engine-zfs) 20%, transparent); color: var(--color-engine-zfs); }
</style>
