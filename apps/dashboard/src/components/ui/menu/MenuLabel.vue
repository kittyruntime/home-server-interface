<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { onBeforeUnmount, onMounted, ref, useId } from "vue"
import { useMenuContext, useMenuGroupLabel } from "@/lib/use-menu"
import { cn } from "@/lib/utils"
import { menuSlot } from "./styles"

const props = defineProps<{ class?: HTMLAttributes["class"], inset?: boolean }>()
const ctx = useMenuContext()

// Inside a group, the label is what names it.
const group = useMenuGroupLabel()
// Read back from the element so an id given by the caller is the one referenced.
const fallbackId = useId()
const el = ref<HTMLElement | null>(null)
let id = ""
onMounted(() => {
  id = el.value?.id ?? ""
  if (group && id) group.labelId.value = id
})
onBeforeUnmount(() => { if (group && group.labelId.value === id) group.labelId.value = undefined })
</script>

<template>
  <li
    :id="fallbackId"
    ref="el"
    role="presentation"
    :data-slot="menuSlot(ctx.kind, 'label')"
    :data-inset="inset ? '' : undefined"
    :class="cn('menu-title text-base-content flex-row flex-nowrap items-center data-[inset]:pl-8', props.class)"
  >
    <slot />
  </li>
</template>
