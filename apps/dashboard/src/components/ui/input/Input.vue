<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { ref, useAttrs } from "vue"
import { useVModel } from "@vueuse/core"
import { cn } from "@/lib/utils"

const props = defineProps<{
  defaultValue?: string | number
  modelValue?: string | number
  class?: HTMLAttributes["class"]
}>()

const emits = defineEmits<{
  (e: "update:modelValue", payload: string | number): void
}>()

const modelValue = useVModel(props, "modelValue", emits, {
  passive: true,
  defaultValue: props.defaultValue,
})

const attrs = useAttrs()

// Callers focus or select the field through a template ref.
const el = ref<HTMLInputElement | null>(null)
defineExpose({
  el,
  focus: (options?: Parameters<HTMLElement["focus"]>[0]) => el.value?.focus(options),
  select: () => el.value?.select(),
})
</script>

<template>
  <input
    ref="el"
    v-model="modelValue"
    data-slot="input"
    :class="cn(
      attrs.type === 'file' ? 'file-input aria-invalid:file-input-error' : 'input aria-invalid:input-error',
      'w-full min-w-0 disabled:cursor-not-allowed',
      props.class,
    )"
  >
</template>
