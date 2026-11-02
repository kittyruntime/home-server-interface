<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { ref } from "vue"
import { cn } from "@/lib/utils"
import { useCheckedModel } from "../checked-model"

// The model is true, false or "indeterminate", which the native control shows
// through its indeterminate property.
const props = withDefaults(defineProps<{
  modelValue?: boolean | "indeterminate"
  defaultValue?: boolean | "indeterminate"
  class?: HTMLAttributes["class"]
}>(), { modelValue: undefined, defaultValue: undefined })

const emits = defineEmits<{
  "update:modelValue": [value: boolean | "indeterminate"]
}>()

const el = ref<HTMLInputElement | null>(null)
const { onChange } = useCheckedModel(props, emits, el)
</script>

<template>
  <input
    ref="el"
    type="checkbox"
    data-slot="checkbox"
    :class="cn('checkbox checkbox-xs checkbox-primary aria-invalid:checkbox-error disabled:cursor-not-allowed', props.class)"
    @change="onChange"
  >
</template>
