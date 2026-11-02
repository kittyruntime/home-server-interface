<script setup lang="ts">
import type { Ref } from "vue"
import { useVModel } from "@vueuse/core"
import { inject, provide, shallowRef, useId } from "vue"
import { DEFAULT_DELAY, tooltipKey, tooltipProviderKey } from "./context"

const props = withDefaults(defineProps<{
  open?: boolean
  defaultOpen?: boolean
  delayDuration?: number
  disableHoverableContent?: boolean
  disableClosingTrigger?: boolean
  disabled?: boolean
  ignoreNonKeyboardFocus?: boolean
}>(), {
  open: undefined,
  defaultOpen: false,
  delayDuration: undefined,
})
const emit = defineEmits<{ "update:open": [value: boolean] }>()

const open = useVModel(props, "open", emit, { passive: true, defaultValue: props.defaultOpen }) as Ref<boolean>
const provider = inject(tooltipProviderKey, null)
const trigger = shallowRef<HTMLElement | null>(null)

provide(tooltipKey, {
  open,
  contentId: useId(),
  delay: () => props.delayDuration ?? provider?.delayDuration.value ?? DEFAULT_DELAY,
  anchor: () => trigger.value,
  setTrigger: el => { trigger.value = el },
})
</script>

<template>
  <slot :open="open" />
</template>
