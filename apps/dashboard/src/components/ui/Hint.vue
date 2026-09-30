<script setup lang="ts">
import { ref, onUnmounted, useId } from 'vue'
import { pushEscLayer } from '../../lib/escLayer'

/* Small inline help affordance: a "?" trigger that reveals a short popover
   on hover, focus or click. Use next to controls whose purpose or effect
   isn't obvious from their label alone, not as a substitute for good
   labels. Keep `text` to one or two sentences; for anything longer, link
   out to docs instead. */
defineProps<{ text: string }>()

const open = ref(false)
const id = useId()

let releaseEsc: (() => void) | null = null
function show() {
  open.value = true
  releaseEsc = pushEscLayer(hide)
}
function hide() {
  open.value = false
  releaseEsc?.()
  releaseEsc = null
}

// Ignore focus that isn't from keyboard navigation: a dialog's initial
// autofocus can otherwise land here (e.g. when this is the first focusable
// element) and pop the tooltip open unprompted.
function onFocus(e: FocusEvent) {
  if ((e.target as HTMLElement).matches(':focus-visible')) show()
}

onUnmounted(() => releaseEsc?.())
</script>

<template>
  <span class="relative inline-flex" @mouseenter="show" @mouseleave="hide">
    <button
      type="button"
      class="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-semibold leading-none text-[var(--c-text-3)] ring-1 ring-inset ring-[var(--c-border-strong)] hover:text-[var(--c-text-1)] hover:ring-[var(--c-text-3)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--c-accent)]"
      :aria-describedby="id"
      aria-label="More info"
      @click.stop="open = !open"
      @focus="onFocus"
      @blur="hide"
    >?</button>
    <Transition name="ui-fade">
      <div
        v-if="open"
        :id="id"
        role="tooltip"
        class="absolute top-full left-1/2 z-20 mt-1.5 w-56 -translate-x-1/2 rounded-lg border border-[var(--c-border-strong)] bg-[var(--c-surface-alt)] p-2.5 text-xs leading-snug text-[var(--c-text-2)] shadow-lg"
      >{{ text }}</div>
    </Transition>
  </span>
</template>
