<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { appGlyph } from '../../lib/app-glyphs'

// An app's icon on its tile: the catalog logo, the generic icon picked for an
// app added by hand, or the first letter of the name otherwise. The tile is a continuous rounded square, as
// app icons are drawn; it is not a control, so it ignores the roundness choice.
const props = withDefaults(defineProps<{ svg?: string | null; glyph?: string | null; name: string; size?: 'sm' | 'md' | 'lg' | 'xl' }>(), { size: 'md' })
const glyphIcon = computed(() => props.svg ? null : appGlyph(props.glyph))
</script>

<template>
  <span class="app-tile" :class="`app-tile--${size}`" aria-hidden="true">
    <AppIcon v-if="svg" :svg="svg" />
    <component :is="glyphIcon" v-else-if="glyphIcon" class="app-tile__glyph" />
    <span v-else class="app-tile__letter">{{ name.charAt(0).toUpperCase() }}</span>
  </span>
</template>

<style scoped>
.app-tile {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border-radius: 23%;
  background: var(--color-base-200);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--color-base-content) 9%, transparent);
  user-select: none;
}
.app-tile--sm { width: 2rem; height: 2rem; padding: 0.3125rem; }
.app-tile--md { width: 2.75rem; height: 2.75rem; padding: 0.4375rem; }
.app-tile--lg { width: 4rem; height: 4rem; padding: 0.6875rem; }
.app-tile--xl { width: 6.5rem; height: 6.5rem; padding: 1.125rem; }
.app-tile__glyph {
  width: 100%;
  height: 100%;
  stroke-width: 1.75;
  color: var(--color-primary);
}
.app-tile__letter {
  font-weight: 600;
  line-height: 1;
  color: color-mix(in oklab, var(--color-base-content) 70%, transparent);
}
.app-tile--sm .app-tile__letter { font-size: 0.875rem; }
.app-tile--md .app-tile__letter { font-size: 1.125rem; }
.app-tile--lg .app-tile__letter { font-size: 1.5rem; }
.app-tile--xl .app-tile__letter { font-size: 2.5rem; }
</style>
