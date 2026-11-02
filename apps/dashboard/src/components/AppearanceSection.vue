<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Card } from '@/components/ui/card'
import { THEMES, type AccentChoice, type Density } from '../lib/appearance'
import { useAppearance } from '../lib/theme'

const { t } = useI18n()
const { appearance, setAppearance, resetAppearance } = useAppearance()

const ACCENTS: { value: AccentChoice; color?: string }[] = [
  { value: 'theme' },
  { value: 'red',    color: '#d71921' },
  { value: 'orange', color: '#f97316' },
  { value: 'blue',   color: '#3b82f6' },
  { value: 'green',  color: '#22c55e' },
  { value: 'purple', color: '#a855f7' },
]

const DENSITIES: Density[] = ['compact', 'default', 'roomy']

const radius = computed({
  get: () => appearance.value.radius,
  set: v => setAppearance({ radius: Number(v) as 0 | 1 | 2 | 3 | 4 }),
})
</script>

<template>
  <div class="space-y-6">
    <!-- ── Theme ── -->
    <div class="space-y-2">
      <h4 class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('appearance.theme') }}</h4>
      <Card class="gap-0 py-0 shadow-none p-3">
        <div role="radiogroup" :aria-label="t('appearance.theme')" class="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto p-1 sm:grid-cols-3">
          <label
            class="flex cursor-pointer items-center gap-2 rounded-box border border-base-300 bg-base-100 px-3 py-2 text-sm text-base-content has-[:checked]:outline-2 has-[:checked]:outline-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary"
          >
            <input
              type="radio" name="appearance-theme" value="auto" class="sr-only"
              :checked="appearance.theme === 'auto'"
              @change="setAppearance({ theme: 'auto' })"
            />
            <span class="truncate">{{ t('appearance.auto') }}</span>
          </label>
          <label
            v-for="name in THEMES" :key="name" :data-theme="name"
            class="flex cursor-pointer items-center gap-2 rounded-box border border-base-300 bg-base-100 px-3 py-2 text-sm text-base-content has-[:checked]:outline-2 has-[:checked]:outline-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary"
          >
            <input
              type="radio" name="appearance-theme" :value="name" class="sr-only"
              :checked="appearance.theme === name"
              @change="setAppearance({ theme: name })"
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
      <h4 class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('appearance.accent') }}</h4>
      <Card class="gap-0 py-0 shadow-none px-4 py-3">
        <div role="radiogroup" :aria-label="t('appearance.accent')" class="flex flex-wrap gap-x-4 gap-y-2">
          <label v-for="opt in ACCENTS" :key="opt.value" class="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio" name="appearance-accent" :value="opt.value"
              class="radio radio-sm" :class="{ 'radio-neutral': !opt.color }"
              :style="opt.color ? { '--input-color': opt.color } : undefined"
              :checked="appearance.accent === opt.value"
              @change="setAppearance({ accent: opt.value })"
            />
            {{ t(`appearance.accents.${opt.value}`) }}
          </label>
        </div>
      </Card>
    </div>

    <!-- ── Roundness ── -->
    <div class="space-y-2">
      <h4 class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('appearance.roundness') }}</h4>
      <Card class="gap-0 py-0 shadow-none px-4 py-3">
        <input
          v-model="radius" type="range" min="0" max="4" step="1"
          class="range range-primary range-sm w-full max-w-xs"
          :aria-label="t('appearance.roundness')"
        />
        <div class="mt-1 flex w-full max-w-xs justify-between text-xs text-base-content/60" aria-hidden="true">
          <span>{{ t('appearance.square') }}</span>
          <span>{{ t('appearance.round') }}</span>
        </div>
      </Card>
    </div>

    <!-- ── Density ── -->
    <div class="space-y-2">
      <h4 class="text-xs font-semibold uppercase tracking-caps text-muted-foreground">{{ t('appearance.density') }}</h4>
      <Card class="gap-0 py-0 shadow-none px-4 py-3">
        <div role="radiogroup" :aria-label="t('appearance.density')" class="join">
          <input
            v-for="d in DENSITIES" :key="d"
            type="radio" name="appearance-density" :value="d"
            class="join-item btn btn-sm"
            :aria-label="t(`appearance.densities.${d}`)"
            :checked="appearance.density === d"
            @change="setAppearance({ density: d })"
          />
        </div>
      </Card>
    </div>

    <button type="button" class="btn btn-ghost btn-sm" @click="resetAppearance">{{ t('appearance.reset') }}</button>
  </div>
</template>
