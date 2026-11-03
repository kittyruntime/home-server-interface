<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useMenuContext } from "@/lib/use-menu"
import { cn } from "@/lib/utils"
import { menuSlot } from "./styles"

const props = defineProps<{ class?: HTMLAttributes["class"] }>()
const ctx = useMenuContext()
</script>

<template>
  <span
    :data-slot="menuSlot(ctx.kind, 'shortcut')"
    :class="cn('text-base-content/60 ml-auto text-xs tracking-widest', props.class)"
  >
    <slot />
  </span>
</template>
