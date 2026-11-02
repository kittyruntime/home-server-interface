<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"
import { Separator } from "@/components/ui/separator"

const props = withDefaults(defineProps<{
  orientation?: "horizontal" | "vertical"
  decorative?: boolean
  class?: HTMLAttributes["class"]
}>(), {
  orientation: "vertical",
  decorative: true,
})
</script>

<template>
  <Separator
    data-slot="button-group-separator"
    :orientation="props.orientation"
    :decorative="props.decorative"
    :class="cn(
      'bg-base-300 relative !m-0 self-stretch data-[orientation=vertical]:h-auto',
      props.class,
    )"
  />
</template>
