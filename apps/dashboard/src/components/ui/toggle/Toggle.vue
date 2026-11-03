<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ToggleVariants } from "."
import { ref } from "vue"
import { cn } from "@/lib/utils"
import { toggleVariants } from "."

const props = withDefaults(defineProps<{
  modelValue?: boolean
  defaultValue?: boolean
  disabled?: boolean
  class?: HTMLAttributes["class"]
  variant?: ToggleVariants["variant"]
  size?: ToggleVariants["size"]
}>(), {
  modelValue: undefined,
  defaultValue: false,
  variant: "default",
  size: "default",
  disabled: false,
})

const emits = defineEmits<{
  "update:modelValue": [value: boolean]
}>()

const local = ref(props.defaultValue)

function pressed() {
  return props.modelValue !== undefined ? props.modelValue : local.value
}

function toggle() {
  const next = !pressed()
  local.value = next
  emits("update:modelValue", next)
}
</script>

<template>
  <button
    type="button"
    data-slot="toggle"
    :aria-pressed="pressed()"
    :data-state="pressed() ? 'on' : 'off'"
    :disabled="disabled"
    :class="cn(toggleVariants({ variant, size }), props.class)"
    @click="toggle"
  >
    <slot :model-value="pressed()" />
  </button>
</template>
