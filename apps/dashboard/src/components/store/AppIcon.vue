<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAppearance } from '../../lib/theme'

// An App Store logo (#26). Catalog icons now come from the online catalog, so
// they are drawn as an image, where an SVG never runs a script, not inserted
// as markup. currentColor has no meaning inside an image: it is replaced by
// the theme's text color, read again when the theme changes.
const props = defineProps<{ svg: string }>()
const { appearance } = useAppearance()
const ink = ref('#555')

watch(() => appearance.value.theme, () => {
  requestAnimationFrame(() => {
    const c = getComputedStyle(document.documentElement).getPropertyValue('--color-base-content').trim()
    if (c) ink.value = c
  })
}, { immediate: true })

const src = computed(() =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(props.svg.replaceAll('currentColor', ink.value))}`)
</script>

<template>
  <img :src="src" alt="" aria-hidden="true" draggable="false" class="size-full object-contain">
</template>
