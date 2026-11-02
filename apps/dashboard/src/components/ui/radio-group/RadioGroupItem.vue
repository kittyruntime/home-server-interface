<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { RadioValue } from "./context"
import { inject, onMounted, ref, watchEffect } from "vue"
import { cn } from "@/lib/utils"
import { radioGroupKey } from "./context"

const props = defineProps<{
  value: RadioValue
  disabled?: boolean
  class?: HTMLAttributes["class"]
}>()

const group = inject(radioGroupKey, null)
const el = ref<HTMLInputElement | null>(null)

// The model may hold any scalar, so checked is compared here, not in the DOM.
function sync() {
  if (el.value && group)
    el.value.checked = group.model.value === props.value
}

watchEffect(() => {
  void group?.model.value
  void group?.tick.value
  sync()
}, { flush: "post" })
onMounted(sync)
</script>

<template>
  <input
    ref="el"
    type="radio"
    data-slot="radio-group-item"
    :name="group?.name.value"
    :value="String(props.value)"
    :disabled="props.disabled || group?.disabled.value"
    :required="group?.required.value"
    :class="cn('radio radio-xs radio-primary aria-invalid:radio-error disabled:cursor-not-allowed', props.class)"
    @change="group?.select(props.value)"
  >
</template>
