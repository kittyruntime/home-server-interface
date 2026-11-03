import type { Ref } from "vue"
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"

type CheckedState = boolean | "indeterminate"

/**
 * Controlled or uncontrolled state for a native checkbox. The DOM is written
 * back after every change, so a parent that refuses the new value (or lets an
 * event handler decide) always sees the control reflect its own model.
 */
export function useCheckedModel<T extends CheckedState = CheckedState>(
  props: { modelValue?: T, defaultValue?: T },
  emit: (event: "update:modelValue", value: T) => void,
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
    // A native change event only ever yields true or false, never "indeterminate".
    const next = (event.target as HTMLInputElement).checked
    local.value = next
    emit("update:modelValue", next as T)
    nextTick(sync)
  }

  // A prevented click reverts the checkbox after the listeners return and
  // fires no change event: rewrite the DOM once the browser is done.
  let timer: ReturnType<typeof setTimeout> | undefined
  function onClick() {
    clearTimeout(timer)
    timer = setTimeout(sync, 0)
  }
  onBeforeUnmount(() => clearTimeout(timer))

  return { onChange, onClick }
}
