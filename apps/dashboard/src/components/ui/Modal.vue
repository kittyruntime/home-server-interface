<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'

withDefaults(defineProps<{
  /** Tailwind width/max-width classes for the dialog panel. */
  panelClass?: string
  closeOnBackdrop?: boolean
}>(), {
  panelClass: 'w-full max-w-md',
  closeOnBackdrop: true,
})

const emit = defineEmits<{ close: [] }>()

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      @click.self="closeOnBackdrop && emit('close')"
    >
      <div :class="['bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-2xl shadow-2xl flex flex-col max-h-[90vh]', panelClass]">
        <div v-if="$slots.header" class="flex items-center justify-between px-6 py-4 border-b border-[var(--c-border)] shrink-0">
          <slot name="header" />
        </div>

        <!-- Non-scrolling region between header and body, e.g. a tab bar. -->
        <div v-if="$slots.subheader" class="shrink-0">
          <slot name="subheader" />
        </div>

        <div class="flex-1 overflow-y-auto min-h-0">
          <slot />
        </div>

        <div v-if="$slots.footer" class="px-6 py-4 border-t border-[var(--c-border)] flex items-center gap-2 shrink-0">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
