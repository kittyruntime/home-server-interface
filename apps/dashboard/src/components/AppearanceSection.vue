<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Card } from '@/components/ui/card'
import { CheckIcon } from '@lucide/vue'
import { ACCENT_COLORS, ACCENT_NAMES, THEMES, type AccentChoice, type Appearance, type Density } from '../lib/appearance'
import ThemePreview from './ThemePreview.vue'
import { useAppearance } from '../lib/theme'

const { t } = useI18n()
const { appearance, setAppearance, resetAppearance } = useAppearance()

const ACCENTS: { value: AccentChoice; color?: string }[] = [
  { value: 'theme' },
  ...ACCENT_NAMES.map(value => ({ value, color: ACCENT_COLORS[value][0] })),
]

// Each group writes through the model, so a value the store rejects or normalizes is shown as stored.
const theme = computed({ get: () => appearance.value.theme, set: v => setAppearance({ theme: v }) })
const accent = computed({ get: () => appearance.value.accent, set: v => setAppearance({ accent: v }) })
const radius = computed({ get: () => appearance.value.radius, set: v => setAppearance({ radius: v }) })
const density = computed({ get: () => appearance.value.density, set: v => setAppearance({ density: v }) })

const DENSITIES: Density[] = ['compact', 'default', 'roomy']

const RADII: { value: Appearance['radius']; key: string }[] = [
  { value: 2, key: 'theme' },
  { value: 0, key: 'square' },
  { value: 1, key: 'slight' },
  { value: 3, key: 'round' },
  { value: 4, key: 'pill' },
]
</script>

<template>
  <div class="space-y-6">
    <!-- ── Theme ── -->
    <div class="space-y-2">
      <h4 class="text-xs font-semibold uppercase tracking-caps text-base-content/70">{{ t('appearance.theme') }}</h4>
      <Card class="gap-0 py-0 shadow-none p-3">
        <div role="radiogroup" :aria-label="t('appearance.theme')" class="grid grid-cols-2 gap-3 p-1 sm:grid-cols-3 lg:grid-cols-5">
          <label v-for="name in ['auto', ...THEMES] as const" :key="name"
            class="group cursor-pointer rounded-box outline-offset-2 has-[:checked]:outline-2 has-[:checked]:outline-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary">
            <input type="radio" name="appearance-theme" :value="name" class="sr-only" v-model="theme">
            <span class="relative block overflow-hidden rounded-box border border-base-300 transition-colors duration-(--dur-fast) group-hover:border-base-content/30">
              <span v-if="name === 'auto'" class="grid grid-cols-2" aria-hidden="true">
                <ThemePreview theme="light" />
                <ThemePreview theme="dark" />
              </span>
              <ThemePreview v-else :theme="name" aria-hidden="true" />
            </span>
            <span class="mt-1.5 flex items-center gap-1.5 px-0.5 text-sm text-base-content">
              <span class="truncate">{{ name === 'auto' ? t('appearance.auto') : t(`appearance.themes.${name}`) }}</span>
              <CheckIcon v-if="theme === name" class="size-3.5 shrink-0 text-primary" aria-hidden="true" />
            </span>
          </label>
        </div>
      </Card>
    </div>

    <!-- ── Accent color ── -->
    <div class="space-y-2">
      <h4 class="text-xs font-semibold uppercase tracking-caps text-base-content/70">{{ t('appearance.accent') }}</h4>
      <Card class="gap-0 py-0 shadow-none px-4 py-3">
        <div role="radiogroup" :aria-label="t('appearance.accent')" class="flex flex-wrap gap-x-4 gap-y-2">
          <label v-for="opt in ACCENTS" :key="opt.value" class="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio" name="appearance-accent" :value="opt.value"
              class="radio radio-sm" :class="{ 'radio-neutral': !opt.color }"
              :style="opt.color ? { '--input-color': opt.color } : undefined"
              v-model="accent"
            >
            {{ t(`appearance.accents.${opt.value}`) }}
          </label>
        </div>
      </Card>
    </div>

    <!-- ── Roundness ── -->
    <div class="space-y-2">
      <h4 class="text-xs font-semibold uppercase tracking-caps text-base-content/70">{{ t('appearance.roundness') }}</h4>
      <Card class="gap-0 py-0 shadow-none px-4 py-3">
        <div role="radiogroup" :aria-label="t('appearance.roundness')" class="tabs tabs-box tabs-sm w-fit">
          <input
            v-for="r in RADII" :key="r.value"
            type="radio" name="appearance-radius" :value="r.value"
            class="tab"
            :aria-label="t(`appearance.radii.${r.key}`)"
            v-model="radius"
          >
        </div>
      </Card>
    </div>

    <!-- ── Density ── -->
    <div class="space-y-2">
      <h4 class="text-xs font-semibold uppercase tracking-caps text-base-content/70">{{ t('appearance.density') }}</h4>
      <Card class="gap-0 py-0 shadow-none px-4 py-3">
        <div role="radiogroup" :aria-label="t('appearance.density')" class="tabs tabs-box tabs-sm w-fit">
          <input
            v-for="d in DENSITIES" :key="d"
            type="radio" name="appearance-density" :value="d"
            class="tab"
            :aria-label="t(`appearance.densities.${d}`)"
            v-model="density"
          >
        </div>
      </Card>
    </div>

    <button type="button" class="btn btn-ghost btn-sm" @click="resetAppearance">{{ t('appearance.reset') }}</button>
  </div>
</template>
