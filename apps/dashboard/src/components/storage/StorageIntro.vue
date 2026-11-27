<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import IntroCard from './IntroCard.vue'
import { UPSTREAM, type DocPage } from '../../lib/storage-docs'

// The intro card of a Storage tab: its layers, and where to learn more.
const props = defineProps<{ tab: 'disks' | 'pools' | 'lvm' | 'zfs' | 'maintenance' }>()
const { t } = useI18n()

const STAGES: Record<typeof props.tab, string[]> = {
  disks: ['disk', 'owner', 'health'],
  pools: ['disks', 'pool', 'volumes'],
  lvm: ['disks', 'volumeGroup', 'volumes'],
  zfs: ['disks', 'vdev', 'pool', 'datasets'],
  maintenance: ['smart', 'raidCheck', 'alerts'],
}
const GUIDE: Record<typeof props.tab, DocPage> = { disks: 'disks', pools: 'storage', lvm: 'lvm', zfs: 'zfs', maintenance: 'maintenance' }

const card = computed(() => {
  const k = `ui.storage.intros.${props.tab}`
  return {
    title: t(`${k}.title`),
    stages: STAGES[props.tab].map(s => ({ title: t(`${k}.${s}`), caption: t(`${k}.${s}Caption`) })),
    note: props.tab === 'lvm' || props.tab === 'pools' ? t(`${k}.note`) : undefined,
    upstream: props.tab === 'pools'
      ? [{ label: t('ui.storage.intros.linuxRaid'), href: UPSTREAM.mdadm }, { label: 'LVM2', href: UPSTREAM.lvm }, { label: 'OpenZFS', href: UPSTREAM.openzfs }]
      : props.tab === 'lvm'
        ? [{ label: 'LVM2', href: UPSTREAM.lvm }, { label: 'lvm(8)', href: UPSTREAM.lvmMan }, { label: t('ui.storage.intros.linuxRaid'), href: UPSTREAM.mdadm }]
        : props.tab === 'zfs' ? [{ label: 'OpenZFS', href: UPSTREAM.openzfs }]
        : [{ label: 'smartmontools', href: UPSTREAM.smartmontools }],
  }
})
</script>

<template>
  <IntroCard :id="props.tab" :title="card.title" :stages="card.stages" :note="card.note" :guide="GUIDE[props.tab]" :upstream="card.upstream" />
</template>
