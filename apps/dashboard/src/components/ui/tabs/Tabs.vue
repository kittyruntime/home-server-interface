<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { PrimitiveProps } from "../Primitive.vue"
import { computed, provide, ref, useId } from "vue"
import { cn } from "@/lib/utils"
import Primitive from "../Primitive.vue"
import { keepFocused, tabsKey } from "./context"

type TabValue = string | undefined

interface TabsProps extends PrimitiveProps {
  modelValue?: TabValue
  defaultValue?: TabValue
  orientation?: "horizontal" | "vertical"
  activationMode?: "automatic" | "manual"
  class?: HTMLAttributes["class"]
}

const props = withDefaults(defineProps<TabsProps>(), {
  modelValue: undefined,
  defaultValue: undefined,
  orientation: "horizontal",
  activationMode: "automatic",
  as: "div",
})

const emits = defineEmits<{
  "update:modelValue": [value: string]
}>()

const baseId = `tabs-${useId()}`
const local = ref<TabValue>(props.defaultValue)
const model = computed(() => props.modelValue !== undefined ? props.modelValue : local.value)

function select(value: string) {
  if (value === model.value)
    return
  local.value = value
  emits("update:modelValue", value)
}

// Triggers found in the tablist: the enabled ones in order, and every value
const listEl = ref<HTMLElement | null>(null)
const first = ref<string | null>(null)
const enabled = ref<string[]>([])
const focused = ref<string | null>(null)

function refresh() {
  const all = Array.from(listEl.value?.querySelectorAll<HTMLElement>("[data-tab-trigger]:not(:disabled)") ?? [])
  const values = all.map(item => item.dataset.value ?? "")
  if (values.join("\u0000") !== enabled.value.join("\u0000"))
    enabled.value = values
  // Include the disabled ones: a trigger that merely became disabled is still there.
  focused.value = keepFocused(focused.value, Array.from(listEl.value?.querySelectorAll<HTMLElement>("[data-tab-trigger]") ?? [], item => item.dataset.value ?? ""))
  const head = values[0] ?? null
  if (head !== first.value)
    first.value = head
}

// The tab stop: the focused trigger, else the selected one, else the first.
// A value that is gone or disabled is ignored, or no trigger would be reachable.
const stop = computed(() => {
  if (focused.value !== null && enabled.value.includes(focused.value))
    return focused.value
  const current = model.value
  if (current !== undefined && enabled.value.includes(current))
    return current
  return first.value
})

provide(tabsKey, {
  baseId,
  orientation: computed(() => props.orientation),
  activationMode: computed(() => props.activationMode),
  model,
  select,
  listEl,
  stop,
  focused,
  refresh,
})
</script>

<template>
  <Primitive
    :as="props.as"
    :as-child="props.asChild"
    data-slot="tabs"
    :data-orientation="orientation"
    :class="cn('flex flex-col gap-2', props.class)"
  >
    <slot :model-value="model" />
  </Primitive>
</template>
