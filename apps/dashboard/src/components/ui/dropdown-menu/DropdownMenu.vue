<script setup lang="ts">
import type { Ref } from "vue"
import { useVModel } from "@vueuse/core"
import { useMenu } from "@/lib/use-menu"

const props = withDefaults(defineProps<{
  open?: boolean
  defaultOpen?: boolean
  /** Accepted for compatibility: a menu never blocks the page. */
  modal?: boolean
  dir?: "ltr" | "rtl"
}>(), {
  open: undefined,
  defaultOpen: false,
  modal: true,
  dir: undefined,
})
const emit = defineEmits<{ "update:open": [value: boolean] }>()

const open = useVModel(props, "open", emit, { passive: true, defaultValue: props.defaultOpen }) as Ref<boolean>
useMenu({ kind: "dropdown", open })
</script>

<template>
  <slot :open="open" />
</template>
