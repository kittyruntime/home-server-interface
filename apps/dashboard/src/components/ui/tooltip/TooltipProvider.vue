<script setup lang="ts">
import { provide, toRef } from "vue"
import { DEFAULT_DELAY, tooltipProviderKey } from "./context"

/* Sets the default hover delay of the tooltips below it. Other
   provider props are accepted and ignored. */
const props = withDefaults(defineProps<{
  delayDuration?: number
  skipDelayDuration?: number
  disableHoverableContent?: boolean
  disableClosingTrigger?: boolean
  disabled?: boolean
  ignoreNonKeyboardFocus?: boolean
}>(), {
  delayDuration: DEFAULT_DELAY,
})

provide(tooltipProviderKey, { delayDuration: toRef(props, "delayDuration") })
</script>

<template>
  <slot />
</template>
