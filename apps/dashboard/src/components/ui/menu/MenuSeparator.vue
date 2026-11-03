<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useMenuContext } from "@/lib/use-menu"
import { cn } from "@/lib/utils"
import { menuSlot } from "./styles"

const props = defineProps<{ class?: HTMLAttributes["class"] }>()
const ctx = useMenuContext()
</script>

<template>
  <li
    role="separator"
    aria-orientation="horizontal"
    :data-slot="menuSlot(ctx.kind, 'separator')"
    :class="cn('mx-1 my-1', props.class)"
  />
</template>
