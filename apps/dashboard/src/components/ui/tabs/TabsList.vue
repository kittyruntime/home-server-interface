<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { inject, onMounted, ref, watch } from "vue"
import { cn } from "@/lib/utils"
import { nextIndex } from "@/lib/menu-navigation"
import { tabsKey } from "./context"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()

const ctx = inject(tabsKey)!
const el = ref<HTMLElement | null>(null)
onMounted(() => {
  ctx.listEl.value = el.value
  ctx.refresh()
})
watch(ctx.model, () => ctx.refresh(), { flush: "post" })

function onFocusout(event: FocusEvent) {
  const next = event.relatedTarget as Node | null
  if (!next || !el.value?.contains(next))
    ctx.focused.value = null
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey)
    return
  const vertical = ctx.orientation.value === "vertical"
  let key: string
  if (event.key === "Home" || event.key === "PageUp")
    key = "Home"
  else if (event.key === "End" || event.key === "PageDown")
    key = "End"
  else if ((vertical && event.key === "ArrowDown") || (!vertical && event.key === "ArrowRight"))
    key = "ArrowDown"
  else if ((vertical && event.key === "ArrowUp") || (!vertical && event.key === "ArrowLeft"))
    key = "ArrowUp"
  else
    return
  // Only the triggers of this list, which a nested list would also match
  const all = Array.from(el.value?.querySelectorAll<HTMLElement>("[data-tab-trigger]") ?? [])
  const current = all.indexOf(document.activeElement as HTMLElement)
  if (current === -1)
    return
  event.preventDefault()
  const target = nextIndex(key, current, all.map(item => (item as HTMLButtonElement).disabled))
  all[target]?.focus()
}
</script>

<template>
  <div
    ref="el"
    role="tablist"
    :aria-orientation="ctx.orientation.value"
    data-slot="tabs-list"
    :data-orientation="ctx.orientation.value"
    :class="cn('tabs tabs-box w-fit', ctx.orientation.value === 'vertical' && 'flex-col', props.class)"
    @focusout="onFocusout"
    @keydown="onKeydown"
  >
    <slot />
  </div>
</template>
