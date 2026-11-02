<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ToggleVariants } from "../toggle"
import { computed, inject } from "vue"
import { cn } from "@/lib/utils"
import { toggleVariants } from "../toggle"
import { toggleGroupKey } from "./context"

const props = defineProps<{
  value: string
  disabled?: boolean
  class?: HTMLAttributes["class"]
  variant?: ToggleVariants["variant"]
  size?: ToggleVariants["size"]
}>()

const group = inject(toggleGroupKey, null)

const on = computed(() => group?.isOn(props.value) ?? false)
const single = computed(() => group?.single.value ?? false)
const variant = computed(() => group?.variant.value ?? props.variant)
const size = computed(() => group?.size.value ?? props.size)
const tabindex = computed(() => group?.stop.value == null ? undefined : group.stop.value === props.value ? 0 : -1)
</script>

<template>
  <button
    type="button"
    data-slot="toggle-group-item"
    data-toggle-item
    :data-value="value"
    :data-state="on ? 'on' : 'off'"
    :data-variant="variant"
    :data-size="size"
    :data-spacing="group?.spacing.value"
    :role="single ? 'radio' : undefined"
    :aria-checked="single ? on : undefined"
    :aria-pressed="single ? undefined : on"
    :tabindex="tabindex"
    :disabled="disabled || group?.disabled.value"
    :class="cn(
      toggleVariants({ variant, size }),
      group?.spacing.value === 0 && 'join-item',
      'w-auto min-w-0 shrink-0 px-3',
      props.class)"
    @click="group?.toggle(value)"
  >
    <slot :model-value="on" />
  </button>
</template>
