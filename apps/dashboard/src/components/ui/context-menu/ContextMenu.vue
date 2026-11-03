<script setup lang="ts">
import { ref, watch } from "vue"
import { useMenu } from "@/lib/use-menu"

defineProps<{
  /** Accepted for compatibility: a menu never blocks the page. */
  modal?: boolean
  dir?: "ltr" | "rtl"
  pressOpenDelay?: number
}>()
const emit = defineEmits<{ "update:open": [value: boolean] }>()

const open = ref(false)
watch(open, value => emit("update:open", value))
useMenu({ kind: "context", open })
</script>

<template>
  <slot />
</template>
