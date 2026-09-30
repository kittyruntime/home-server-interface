<script setup lang="ts">
/* Compact block-distribution diagram for a RAID level, used in the "choose a
   level" step of the create wizard. Purely illustrative, not proportional
   to a real stripe/parity layout, just enough to make striping vs mirroring
   vs parity visually distinct at a glance. */
const props = defineProps<{ level: number }>()

type Block = { label: string; kind: 'a' | 'b' | 'parity' }

const LAYOUTS: Record<number, Block[][]> = {
  // Striping: each drive holds a different block, no duplication.
  0: [[{ label: 'A', kind: 'a' }], [{ label: 'B', kind: 'b' }], [{ label: 'C', kind: 'a' }]],
  // Mirroring: every drive holds an identical copy.
  1: [[{ label: 'A', kind: 'a' }], [{ label: 'A', kind: 'a' }]],
  // Parity: data blocks spread across drives, one parity block per stripe.
  5: [[{ label: 'A', kind: 'a' }], [{ label: 'B', kind: 'b' }], [{ label: 'P', kind: 'parity' }]],
  // Mirror + stripe: two mirrored pairs, striped across each other.
  10: [
    [{ label: 'A', kind: 'a' }],
    [{ label: 'A', kind: 'a' }],
    [{ label: 'B', kind: 'b' }],
    [{ label: 'B', kind: 'b' }],
  ],
}

const BLOCK_CLASS: Record<Block['kind'], string> = {
  a:       'bg-[var(--c-accent)]/20 text-[var(--c-accent)] border-[var(--c-accent)]/30',
  b:       'bg-violet/20 text-violet border-violet/30',
  parity:  'bg-[var(--c-warning)]/20 text-[var(--c-warning)] border-[var(--c-warning)]/30',
}
</script>

<template>
  <div class="flex items-end justify-center gap-1.5" role="img" :aria-label="`${props.level === 10 ? 'mirrored pairs, striped' : props.level === 1 ? 'identical copies on every drive' : props.level === 5 ? 'data and parity spread across drives' : 'data striped across drives'}`">
    <div v-for="(drive, i) in LAYOUTS[props.level]" :key="i" class="flex flex-col items-center gap-1">
      <div class="flex flex-col-reverse gap-0.5">
        <div
          v-for="(b, j) in drive" :key="j"
          :class="['flex h-5 w-6 items-center justify-center rounded-sm border text-[9px] font-bold', BLOCK_CLASS[b.kind]]"
        >{{ b.label }}</div>
      </div>
      <div class="h-1 w-7 rounded-full bg-[var(--c-border-strong)]"/>
    </div>
  </div>
</template>
