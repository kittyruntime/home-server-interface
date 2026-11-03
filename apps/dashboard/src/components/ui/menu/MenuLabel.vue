<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { useMenuContext } from "@/lib/use-menu"
import { cn } from "@/lib/utils"
import { menuSlot } from "./styles"

const props = defineProps<{ class?: HTMLAttributes["class"], inset?: boolean }>()
const ctx = useMenuContext()
</script>

<template>
  <li
    role="presentation"
    :data-slot="menuSlot(ctx.kind, 'label')"
    :data-inset="inset ? '' : undefined"
    :class="cn('menu-title text-base-content flex-row flex-nowrap items-center data-[inset]:pl-8', props.class)"
  >
    <slot />
  </li>
</template>
