import type { Ref } from "vue"
import { computed, nextTick, onMounted, ref, watch } from "vue"

type CheckedState = boolean | "indeterminate"

/**
 * Controlled or uncontrolled state for a native checkbox. The DOM is written
 * back after every change, so a parent that refuses the new value (or lets an
 * event handler decide) always sees the control reflect its own model.
 */
export function useCheckedModel(
  props: { modelValue?: CheckedState, defaultValue?: CheckedState },
  emit: (event: "update:modelValue", value: CheckedState) => void,
  el: Ref<HTMLInputElement | null>,
) {
  const local = ref<CheckedState>(props.defaultValue ?? false)
  const state = computed(() => props.modelValue !== undefined ? props.modelValue : local.value)

  function sync() {
    const input = el.value
    if (!input)
      return
    input.indeterminate = state.value === "indeterminate"
    input.checked = state.value === true
  }

  watch(state, sync, { flush: "post" })
  onMounted(sync)

  function onChange(event: Event) {
    const next = (event.target as HTMLInputElement).checked
    local.value = next
    emit("update:modelValue", next)
    nextTick(sync)
  }

  return { onChange }
}
