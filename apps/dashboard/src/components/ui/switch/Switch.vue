<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { ref } from "vue"
import { cn } from "@/lib/utils"
import { useCheckedModel } from "../checked-model"

const props = withDefaults(defineProps<{
  modelValue?: boolean
  defaultValue?: boolean
  class?: HTMLAttributes["class"]
}>(), { modelValue: undefined, defaultValue: undefined })

const emits = defineEmits<{
  "update:modelValue": [value: boolean]
}>()

const el = ref<HTMLInputElement | null>(null)
const { onChange, onClick } = useCheckedModel(props, emits as (event: "update:modelValue", value: boolean | "indeterminate") => void, el)
</script>

<template>
  <input
    ref="el"
    type="checkbox"
    role="switch"
    data-slot="switch"
    :class="cn('toggle toggle-sm toggle-primary disabled:cursor-not-allowed', props.class)"
    @click="onClick"
    @change="onChange"
  >
</template>
