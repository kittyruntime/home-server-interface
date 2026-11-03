<script setup lang="ts">
import { provide } from "vue"
import { radioGroupKey } from "@/lib/use-menu"

defineOptions({ inheritAttrs: false })

const props = defineProps<{ modelValue?: string }>()
const emit = defineEmits<{ "update:modelValue": [value: string] }>()

provide(radioGroupKey, {
  value: () => props.modelValue,
  select: value => emit("update:modelValue", value),
})
</script>

<template>
  <li role="none" class="contents">
    <div role="group" class="contents" v-bind="$attrs">
      <slot />
    </div>
  </li>
</template>
