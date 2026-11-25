<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { HardDriveIcon } from '@lucide/vue'
import { fmtBytes } from './store'
import { bayModel, type Bay, type BayOwner } from './disk-bays'
import type { DiskHealth, DiskRow } from './disk-list'

// The server's disks as the bays of a chassis, colored by what uses them. A
// free bay starts a new volume on that disk.
const props = defineProps<{ rows: DiskRow[] }>()
const emit = defineEmits<{ create: [disks: string[]]; open: [name: string] }>()
const { t } = useI18n()

const bays = computed(() => bayModel(props.rows))
const OWNERS: BayOwner[] = ['lvm', 'zfs', 'free', 'system', 'other']
const present = computed(() => OWNERS.filter(o => bays.value.some(b => b.owner === o)))

// Engine colors come from theme tokens, so every theme keeps them readable.
const BORDER: Record<BayOwner, string> = {
  lvm: 'border-secondary', zfs: 'border-accent', free: 'border-base-content/40 border-dashed',
  system: 'border-base-content/25', other: 'border-base-300',
}
const ICON: Record<BayOwner, string> = {
  lvm: 'text-secondary', zfs: 'text-accent', free: 'text-base-content/50', system: 'text-base-content/60', other: 'text-base-content/50',
}
const SWATCH: Record<BayOwner, string> = {
  lvm: 'bg-secondary', zfs: 'bg-accent', free: 'border border-dashed border-base-content/50', system: 'bg-base-content/25', other: 'bg-base-300',
}
const DOT: Record<DiskHealth, string> = { passed: 'bg-success', warning: 'bg-warning', failed: 'bg-error', unknown: 'bg-base-content/25' }

function label(b: Bay): string {
  return [b.name, b.label, fmtBytes(b.size), t(`ui.storage.DiskBays.owner.${b.owner}`), t(`ui.storage.DiskBays.health.${b.health}`),
    b.temperature ? `${b.temperature} °C` : ''].filter(Boolean).join(', ')
}
function pick(b: Bay) {
  if (b.owner === 'free') emit('create', [b.name])
  else emit('open', b.name)
}
</script>

<template>
  <figure class="mb-5">
    <div class="grid grid-cols-3 gap-2 rounded-xl bg-base-200 p-3 @xl:grid-cols-6">
      <button v-for="b in bays" :key="b.name" type="button"
        class="flex min-w-0 flex-col items-center gap-0.5 rounded-lg border-2 bg-base-100 px-2 py-2.5 text-center text-xs outline-none transition-colors hover:bg-base-200 focus-visible:ring-3 focus-visible:ring-base-content/30"
        :class="BORDER[b.owner]" :aria-label="label(b)" @click="pick(b)"
      >
        <HardDriveIcon class="size-5" :class="ICON[b.owner]" aria-hidden="true" />
        <span class="mt-0.5 max-w-full truncate font-mono text-sm font-semibold text-base-content">{{ b.name }}</span>
        <span v-if="b.label" class="max-w-full truncate text-base-content/70">{{ b.label }}</span>
        <span class="tabular-nums text-base-content/70">{{ fmtBytes(b.size) }}</span>
        <span class="inline-flex items-center gap-1 tabular-nums text-base-content/70">
          <span class="size-2 rounded-full" :class="DOT[b.health]" aria-hidden="true" />
          {{ b.owner === 'free' ? t('ui.storage.DiskBays.free') : b.temperature ? `${b.temperature} °C` : t(`ui.storage.DiskBays.health.${b.health}`) }}
        </span>
      </button>
    </div>
    <figcaption class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-base-content/70">
      <span v-for="o in present" :key="o" class="inline-flex items-center gap-1.5">
        <span class="size-2.5 rounded-sm" :class="SWATCH[o]" aria-hidden="true" />{{ t(`ui.storage.DiskBays.owner.${o}`) }}
      </span>
      <span v-if="bays.some(b => b.owner === 'free')">{{ t('ui.storage.DiskBays.pickAFreeDisk') }}</span>
    </figcaption>
  </figure>
</template>
