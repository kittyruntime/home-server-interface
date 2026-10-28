<script setup lang="ts">
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Tooltip around a single element, in place of the native `title`. Without
// text it renders the element alone. A disabled control gets no pointer
// events, so `wrap` puts a focusable span around it to keep the tooltip.
defineProps<{
  text?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  wrap?: boolean
}>()
</script>

<template>
  <Tooltip v-if="text">
    <TooltipTrigger as-child>
      <span v-if="wrap" tabindex="0" class="inline-flex rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"><slot /></span>
      <slot v-else />
    </TooltipTrigger>
    <TooltipContent :side="side">{{ text }}</TooltipContent>
  </Tooltip>
  <slot v-else />
</template>
