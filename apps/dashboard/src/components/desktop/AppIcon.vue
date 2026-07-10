<script setup lang="ts">
import type { AppId } from '../../lib/desktop'

// Glyphs drawn on a 24px grid, one continuous stroke path plus filled "dot"
// details (drive LEDs, slider knobs, share nodes). Dots use currentColor so
// the whole glyph tints as one — monochrome by default, accent when focused.
interface IconDef {
  stroke: string
  dots: [cx: number, cy: number, r: number][]
}

const ICONS: Record<AppId, IconDef> = {
  files: {
    stroke: 'M3.5 7.5a2 2 0 012-2h3.3a1.5 1.5 0 011.2.6l1.3 1.65h7.2a2 2 0 012 2v7.75a2 2 0 01-2 2h-13a2 2 0 01-2-2V7.5z',
    dots: [[12, 13.75, 1.4]],
  },
  apps: {
    stroke:
      'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6z' +
      'M14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6z' +
      'M4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2z',
    dots: [[17, 17, 3]],
  },
  settings: {
    stroke: 'M4 5.5h16M4 12h16M4 18.5h16',
    dots: [
      [15.5, 5.5, 2],
      [8.5, 12, 2],
      [13.5, 18.5, 2],
    ],
  },
  storage: {
    stroke:
      'M3.5 6.5a2 2 0 012-2h13a2 2 0 012 2v11a2 2 0 01-2 2h-13a2 2 0 01-2-2v-11z' +
      'M3.5 9.5h17M3.5 14.5h17M6.5 7h4.5M6.5 12h4.5M6.5 17h4.5',
    dots: [
      [16.9, 7, 1.1],
      [16.9, 12, 1.1],
      [16.9, 17, 1.1],
    ],
  },
  monitor: {
    stroke: 'M3.5 12h2.9l2.3-6 3.8 12 2.3-6h2.7',
    dots: [[20.25, 12, 1.4]],
  },
  sharing: {
    stroke: 'M6 12L17.5 5.75M6 12l11.5 6.25',
    dots: [
      [6, 12, 2.4],
      [17.5, 5.75, 2.4],
      [17.5, 18.25, 2.4],
    ],
  },
  'file-preview': {
    stroke: 'M6 5.5a2 2 0 012-2h5.2L18 8.3v10.2a2 2 0 01-2 2H8a2 2 0 01-2-2V5.5zM13.2 3.5v4.8H18',
    dots: [[12, 14.5, 1.5]],
  },
}

withDefaults(defineProps<{ app: AppId; strokeWidth?: number }>(), { strokeWidth: 1.75 })
</script>

<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" :stroke-width="strokeWidth" aria-hidden="true">
    <path :d="ICONS[app].stroke" stroke-linecap="round" stroke-linejoin="round" />
    <circle v-for="(d, i) in ICONS[app].dots" :key="i" :cx="d[0]" :cy="d[1]" :r="d[2]" fill="currentColor" stroke="none" />
  </svg>
</template>
