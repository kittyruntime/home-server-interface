<script lang="ts" setup>
/* vue-sonner writes its theme prop to a data-theme attribute. "light" or
   "dark" would match daisyUI's own [data-theme] selectors and reset the
   palette on the toaster, so the default is "system" (no daisyUI theme of that
   name); the colors come from the CSS variables below. */
import type { ToasterProps } from "vue-sonner"
import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon, XIcon } from "@lucide/vue"
import { cn } from "@/lib/utils"
import { Toaster as Sonner } from "vue-sonner"

const props = defineProps<ToasterProps>()
</script>

<template>
  <Sonner
    :class="cn('toaster group', props.class)"
    :style="{
      '--normal-bg': 'var(--color-base-100)',
      '--normal-text': 'var(--color-base-content)',
      '--normal-border': 'var(--color-base-300)',
      '--success-bg': 'var(--color-base-100)',
      '--success-text': 'var(--color-base-content)',
      '--success-border': 'var(--color-success)',
      '--info-bg': 'var(--color-base-100)',
      '--info-text': 'var(--color-base-content)',
      '--info-border': 'var(--color-info)',
      '--warning-bg': 'var(--color-base-100)',
      '--warning-text': 'var(--color-base-content)',
      '--warning-border': 'var(--color-warning)',
      '--error-bg': 'var(--color-base-100)',
      '--error-text': 'var(--color-base-content)',
      '--error-border': 'var(--color-error)',
      '--border-radius': 'var(--radius-box)',
    }"
    v-bind="props"
    :theme="props.theme ?? 'system'"
    rich-colors
  >
    <template #success-icon>
      <CircleCheckIcon class="size-4" />
    </template>
    <template #info-icon>
      <InfoIcon class="size-4" />
    </template>
    <template #warning-icon>
      <TriangleAlertIcon class="size-4" />
    </template>
    <template #error-icon>
      <OctagonXIcon class="size-4" />
    </template>
    <template #loading-icon>
      <div>
        <Loader2Icon class="size-4 animate-spin" />
      </div>
    </template>
    <template #close-icon>
      <XIcon class="size-4" />
    </template>
  </Sonner>
</template>
