<script setup lang="ts">
import { TooltipProvider } from '@/components/ui/tooltip'
</script>

<template>
  <TooltipProvider :delay-duration="400">
    <RouterView v-slot="{ Component }">
      <Transition name="ui-fade" mode="out-in">
        <!-- .route-fade scopes the fast duration to the fade itself; an inline
             --ui-dur here would inherit into every descendant transition. -->
        <component :is="Component" class="route-fade" />
      </Transition>
    </RouterView>
  </TooltipProvider>
</template>
