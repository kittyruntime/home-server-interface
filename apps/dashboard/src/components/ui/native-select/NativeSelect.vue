<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { reactiveOmit, useVModel } from "@vueuse/core"
import { cn } from "@/lib/utils"

defineOptions({
  inheritAttrs: false,
})

type AcceptableValue = string | number | boolean | bigint | Record<string, unknown> | null

// wrapperClass carries layout (width, margins, flex) to the wrapper: the
// select itself always fills it, as the former .ui-input did.
const props = defineProps<{ modelValue?: AcceptableValue | AcceptableValue[], class?: HTMLAttributes["class"], wrapperClass?: HTMLAttributes["class"] }>()

const emit = defineEmits<{
  "update:modelValue": [value: AcceptableValue]
}>()

const modelValue = useVModel(props, "modelValue", emit, {
  passive: true,
  defaultValue: "",
})

const delegatedProps = reactiveOmit(props, "class", "wrapperClass")
</script>

<template>
  <!-- pe-8 comes last: a caller's px-* must not slide the text under daisyUI's arrow. -->
  <div
    :class="cn('group/native-select relative w-full has-[select:disabled]:opacity-50', props.wrapperClass)"
    data-slot="native-select-wrapper"
  >
    <select
      v-bind="{ ...$attrs, ...delegatedProps }"
      v-model="modelValue"
      data-slot="native-select"
      :class="cn('select aria-invalid:select-error w-full min-w-0 disabled:cursor-not-allowed', props.class, 'pe-8')"
    >
      <slot />
    </select>
  </div>
</template>
