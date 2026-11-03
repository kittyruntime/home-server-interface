<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import type { ToggleVariants } from "../toggle"
import { computed, onMounted, onUpdated, provide, ref } from "vue"
import { cn } from "@/lib/utils"
import { toggleGroupKey, type ToggleGroupVariant } from "./context"

type GroupValue = string | string[] | undefined

const props = withDefaults(defineProps<{
  /** single: radiogroup, one value at most. multiple: group of pressed buttons. */
  type?: "single" | "multiple"
  modelValue?: GroupValue
  defaultValue?: GroupValue
  disabled?: boolean
  /** One tab stop for the whole group, arrow keys move between items. */
  rovingFocus?: boolean
  loop?: boolean
  orientation?: "horizontal" | "vertical"
  class?: HTMLAttributes["class"]
  variant?: ToggleGroupVariant
  size?: ToggleVariants["size"]
  spacing?: number
}>(), {
  type: "single",
  modelValue: undefined,
  defaultValue: undefined,
  rovingFocus: true,
  loop: true,
  orientation: undefined,
  variant: undefined,
  size: undefined,
  spacing: 0,
})

const emits = defineEmits<{
  "update:modelValue": [value: GroupValue]
}>()

const el = ref<HTMLElement | null>(null)
const local = ref<GroupValue>(props.defaultValue)
const model = computed(() => props.modelValue !== undefined ? props.modelValue : local.value)
const single = computed(() => props.type === "single")

function selected(): string[] {
  const value = model.value
  if (Array.isArray(value))
    return value
  return value === undefined || value === "" ? [] : [value]
}

function isOn(value: string) {
  return selected().includes(value)
}

function toggle(value: string) {
  let next: GroupValue
  if (single.value) {
    // Pressing the pressed item releases it
    next = isOn(value) ? undefined : value
  }
  else {
    const current = selected()
    next = current.includes(value) ? current.filter(v => v !== value) : [...current, value]
  }
  local.value = next
  emits("update:modelValue", next)
}

function items(): HTMLElement[] {
  return Array.from(el.value?.querySelectorAll<HTMLElement>("[data-toggle-item]:not(:disabled)") ?? [])
}

// The roving tab stop: the pressed item, else the first one, else the last focused
const focused = ref<string | null>(null)
const first = ref<string | null>(null)
const present = ref<string[]>([])
function refreshFirst() {
  first.value = items()[0]?.dataset.value ?? null
  present.value = items().map(item => item.dataset.value ?? "")
}
onMounted(refreshFirst)
onUpdated(refreshFirst)

const stop = computed(() => {
  if (!props.rovingFocus)
    return null
  // Ignore a focused item that is gone, or every item would get tabindex -1
  if (focused.value !== null && present.value.includes(focused.value))
    return focused.value
  return selected()[0] ?? first.value
})

function onFocusin(event: FocusEvent) {
  const item = (event.target as HTMLElement).closest<HTMLElement>("[data-toggle-item]")
  if (item?.dataset.value !== undefined)
    focused.value = item.dataset.value
}

function onFocusout(event: FocusEvent) {
  const next = event.relatedTarget as Node | null
  if (!next || !el.value?.contains(next))
    focused.value = null
}

function onKeydown(event: KeyboardEvent) {
  if (!props.rovingFocus || event.altKey || event.ctrlKey || event.metaKey)
    return
  const horizontal = props.orientation !== "vertical"
  const vertical = props.orientation !== "horizontal"
  const all = items()
  const index = all.indexOf(document.activeElement as HTMLElement)
  if (index === -1)
    return
  let target: number
  if ((horizontal && event.key === "ArrowRight") || (vertical && event.key === "ArrowDown"))
    target = index + 1
  else if ((horizontal && event.key === "ArrowLeft") || (vertical && event.key === "ArrowUp"))
    target = index - 1
  else if ((event.key === "Home" || event.key === "PageUp"))
    target = 0
  else if ((event.key === "End" || event.key === "PageDown"))
    target = all.length - 1
  else
    return
  event.preventDefault()
  if (props.loop)
    target = (target + all.length) % all.length
  all[target]?.focus()
}

provide(toggleGroupKey, {
  variant: computed(() => props.variant),
  size: computed(() => props.size),
  spacing: computed(() => props.spacing),
  single,
  disabled: computed(() => props.disabled),
  isOn,
  toggle,
  stop,
})
</script>

<template>
  <div
    ref="el"
    :role="single ? 'radiogroup' : 'group'"
    :aria-orientation="orientation"
    data-slot="toggle-group"
    :data-size="size"
    :data-variant="variant"
    :data-spacing="spacing"
    :style="spacing > 0 ? { gap: `calc(var(--spacing) * ${spacing})` } : undefined"
    :class="cn(
      variant === 'tabs' ? ['tabs tabs-box w-fit', size === 'sm' ? 'tabs-sm' : size === 'lg' ? 'tabs-lg' : '']
      : spacing === 0 ? 'join' : 'flex w-fit items-center',
      props.class)"
    @focusin="onFocusin"
    @focusout="onFocusout"
    @keydown="onKeydown"
  >
    <slot :model-value="model" />
  </div>
</template>
