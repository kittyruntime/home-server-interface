<script setup lang="ts">
import type { Ref } from "vue"
import { useVModel } from "@vueuse/core"
import { useMenu, useMenuContext } from "@/lib/use-menu"
import { menuSlot } from "./styles"

const props = withDefaults(defineProps<{
  open?: boolean
  defaultOpen?: boolean
}>(), {
  open: undefined,
  defaultOpen: false,
})
const emit = defineEmits<{ "update:open": [value: boolean] }>()

const open = useVModel(props, "open", emit, { passive: true, defaultValue: props.defaultOpen }) as Ref<boolean>
const parent = useMenuContext()
useMenu({ open, isSub: true })
</script>

<template>
  <li role="none" :data-slot="menuSlot(parent.kind, 'sub')">
    <slot :open="open" />
  </li>
</template>
