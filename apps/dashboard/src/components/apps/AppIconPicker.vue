<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { APP_GLYPHS } from '../../lib/app-glyphs'
import AppTile from '../store/AppTile.vue'

// Picks the generic icon of an app added by hand, or none (its initial).
const model = defineModel<string | null>({ default: null })
defineProps<{ name: string }>()
const { t } = useI18n()
</script>

<template>
  <div role="radiogroup" :aria-label="t('ui.apps.AppIconPicker.label')" class="flex flex-wrap gap-1.5">
    <button type="button" role="radio" :aria-checked="!model" :aria-label="t('ui.apps.AppIconPicker.none')" :title="t('ui.apps.AppIconPicker.none')"
      class="touch-hit relative rounded-field p-1 outline-none transition-colors hover:bg-base-200 focus-visible:ring-2 focus-visible:ring-primary"
      :class="!model && 'bg-primary/10 ring-2 ring-primary'"
      @click="model = null">
      <AppTile :name="name || '?'" size="sm" />
    </button>
    <button v-for="g in APP_GLYPHS" :key="g.id" type="button" role="radio" :aria-checked="model === g.id"
      :aria-label="t(`ui.apps.AppIconPicker.glyphs.${g.id}`)" :title="t(`ui.apps.AppIconPicker.glyphs.${g.id}`)"
      class="touch-hit relative rounded-field p-1 outline-none transition-colors hover:bg-base-200 focus-visible:ring-2 focus-visible:ring-primary"
      :class="model === g.id && 'bg-primary/10 ring-2 ring-primary'"
      @click="model = g.id">
      <AppTile :glyph="g.id" :name="name || '?'" size="sm" />
    </button>
  </div>
</template>
