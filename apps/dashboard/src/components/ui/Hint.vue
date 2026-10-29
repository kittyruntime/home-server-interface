<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref } from 'vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const { t } = useI18n()

/* Small inline help affordance: a "?" trigger that reveals a short popover
   on hover, focus or click. Use next to controls whose purpose or effect
   isn't obvious from their label alone, not as a substitute for good
   labels. Keep `text` to one or two sentences; for anything longer, link
   out to docs instead. */
defineProps<{ text: string }>()

const open = ref(false)

// Ignore focus that isn't from keyboard navigation: a dialog's initial
// autofocus can otherwise land here (e.g. when this is the first focusable
// element) and pop the hint open unprompted.
function onFocus(e: FocusEvent) {
  if ((e.target as HTMLElement).matches(':focus-visible')) open.value = true
}
</script>

<template>
  <Popover v-model:open="open">
    <span class="relative inline-flex" @mouseenter="open = true" @mouseleave="open = false">
      <PopoverTrigger
        type="button"
        class="grid size-4 shrink-0 place-items-center rounded-full text-2xs font-semibold leading-none text-muted-foreground ring-1 ring-inset ring-input outline-none hover:text-foreground hover:ring-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        :aria-label="t('ui.shared.Hint.moreInfo')"
        @click.stop
        @focus="onFocus"
        @blur="open = false"
      >?</PopoverTrigger>
    </span>
    <PopoverContent
      side="bottom"
      :side-offset="6"
      class="w-56 p-2.5 text-xs leading-snug text-foreground/80"
      :trap-focus="false"
      @open-auto-focus.prevent
      @close-auto-focus.prevent
    >{{ text }}</PopoverContent>
  </Popover>
</template>
