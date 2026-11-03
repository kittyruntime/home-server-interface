<script setup lang="ts">
import { provide } from "vue"
import { provideMenuGroup, radioGroupKey } from "@/lib/use-menu"

defineOptions({ inheritAttrs: false })

const props = defineProps<{ modelValue?: string }>()
const emit = defineEmits<{ "update:modelValue": [value: string] }>()

const labelId = provideMenuGroup()

provide(radioGroupKey, {
  value: () => props.modelValue,
  select: value => emit("update:modelValue", value),
})
</script>

<template>
  <li role="none" class="contents">
    <div role="group" class="contents" :aria-labelledby="labelId" v-bind="$attrs">
      <slot />
    </div>
  </li>
</template>
