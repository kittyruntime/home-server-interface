<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { RadioValue } from "./context"
import { computed, nextTick, provide, ref, toRef, useId } from "vue"
import { cn } from "@/lib/utils"
import Primitive from "../Primitive.vue"
import { radioGroupKey } from "./context"

const props = withDefaults(defineProps<{
  modelValue?: RadioValue
  defaultValue?: RadioValue
  disabled?: boolean
  required?: boolean
  name?: string
  as?: string | object
  class?: HTMLAttributes["class"]
}>(), { modelValue: undefined, defaultValue: undefined, name: undefined, as: "div" })

const emits = defineEmits<{
  "update:modelValue": [value: RadioValue]
}>()

const generatedName = `radio-group-${useId()}`
const local = ref<RadioValue | undefined>(props.defaultValue)
const model = computed(() => props.modelValue !== undefined ? props.modelValue : local.value)
const tick = ref(0)

provide(radioGroupKey, {
  name: computed(() => props.name ?? generatedName),
  model,
  disabled: toRef(props, "disabled"),
  required: toRef(props, "required"),
  tick,
  select(value) {
    local.value = value
    emits("update:modelValue", value)
    nextTick(() => tick.value++)
  },
})
</script>

<template>
  <Primitive
    :as="props.as"
    role="radiogroup"
    data-slot="radio-group"
    :class="cn('grid gap-3', props.class)"
  >
    <slot :model-value="model" />
  </Primitive>
</template>
