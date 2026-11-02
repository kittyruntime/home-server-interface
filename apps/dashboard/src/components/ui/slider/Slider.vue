<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { nextTick, onMounted, ref, watch } from "vue"
import { cn } from "@/lib/utils"

// One native range input, so a single thumb: the model is an array of one
// number, as before.
const props = withDefaults(defineProps<{
  modelValue?: number[]
  defaultValue?: number[]
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  class?: HTMLAttributes["class"]
}>(), { modelValue: undefined, defaultValue: undefined, min: 0, max: 100, step: 1 })

const emits = defineEmits<{
  "update:modelValue": [value: number[]]
  "valueCommit": [value: number[]]
}>()

const el = ref<HTMLInputElement | null>(null)
const local = ref<number[]>(props.defaultValue ?? [props.min])

function current() {
  return props.modelValue ?? local.value
}

function sync() {
  if (el.value)
    el.value.value = String(current()[0] ?? props.min)
}

// min, max and step first: the browser clamps value against them.
watch(() => [props.modelValue, props.min, props.max, props.step], sync, { flush: "post" })
onMounted(sync)

function onInput(event: Event) {
  const next = [Number((event.target as HTMLInputElement).value)]
  local.value = next
  emits("update:modelValue", next)
  nextTick(sync)
}

function onChange(event: Event) {
  emits("valueCommit", [Number((event.target as HTMLInputElement).value)])
}
</script>

<template>
  <input
    ref="el"
    type="range"
    data-slot="slider"
    :min="props.min"
    :max="props.max"
    :step="props.step"
    :disabled="props.disabled"
    :class="cn('range range-primary range-xs w-full disabled:opacity-50', props.class)"
    @input="onInput"
    @change="onChange"
  >
</template>
