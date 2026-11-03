<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Card } from '@/components/ui/card'
import { ACCENT_COLORS, ACCENT_NAMES, THEMES, type AccentChoice, type Appearance, type Density } from '../lib/appearance'
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
        <div role="radiogroup" :aria-label="t('appearance.theme')" class="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto p-1 sm:grid-cols-3">
          <label
            class="relative flex cursor-pointer items-center gap-2 rounded-box border border-base-300 bg-base-100 px-3 py-2 text-sm text-base-content has-[:checked]:outline-2 has-[:checked]:outline-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary"
          >
            <input
              type="radio" name="appearance-theme" value="auto" class="sr-only"
              v-model="theme"
            />
            <span class="truncate">{{ t('appearance.auto') }}</span>
          </label>
          <label
            v-for="name in THEMES" :key="name" :data-theme="name"
            class="relative flex cursor-pointer items-center gap-2 rounded-box border border-base-300 bg-base-100 px-3 py-2 text-sm text-base-content has-[:checked]:outline-2 has-[:checked]:outline-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary"
          >
            <input
              type="radio" name="appearance-theme" :value="name" class="sr-only"
              v-model="theme"
            />
            <span class="flex shrink-0 gap-1" aria-hidden="true">
              <span class="size-3 rounded-full bg-primary" />
              <span class="size-3 rounded-full bg-secondary" />
              <span class="size-3 rounded-full bg-accent" />
            </span>
            <span class="truncate">{{ name }}</span>
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
            />
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
          />
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
          />
        </div>
      </Card>
    </div>

    <button type="button" class="btn btn-ghost btn-sm" @click="resetAppearance">{{ t('appearance.reset') }}</button>
  </div>
</template>
