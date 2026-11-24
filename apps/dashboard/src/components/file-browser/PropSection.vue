<script setup lang="ts">
import { computed, useId } from 'vue'
import { ChevronRightIcon } from '@lucide/vue'
import { useFilePrefs, type PropSectionId } from '../../lib/file-prefs'

// A section of the properties window that folds away; which ones are folded
// is remembered with the account's file manager preferences.
const props = defineProps<{ id: PropSectionId; title: string }>()
const { filePrefs, setFilePrefs } = useFilePrefs()
const open = computed(() => !filePrefs.value.foldedSections.includes(props.id))
const bodyId = useId()

function toggle() {
  const folded = filePrefs.value.foldedSections.filter(s => s !== props.id)
  setFilePrefs({ foldedSections: open.value ? [...folded, props.id] : folded })
}
</script>

<template>
  <section class="px-5 py-3">
    <div class="flex items-center justify-between gap-3">
      <button type="button" :aria-expanded="open" :aria-controls="bodyId"
        class="-mx-1 flex flex-1 items-center gap-1.5 rounded-field px-1 py-1 text-left text-xs font-semibold uppercase tracking-caps text-base-content/70 outline-none hover:text-base-content focus-visible:ring-2 focus-visible:ring-primary pointer-coarse:-my-2 pointer-coarse:py-3"
        @click="toggle">
        <ChevronRightIcon class="size-3.5 shrink-0 transition-transform duration-(--dur-base)" :class="open && 'rotate-90'" aria-hidden="true" />
        {{ title }}
      </button>
      <slot name="action" />
    </div>
    <div v-show="open" :id="bodyId" class="mt-2 space-y-2.5">
      <slot />
    </div>
  </section>
</template>
