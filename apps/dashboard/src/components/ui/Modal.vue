<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

withDefaults(defineProps<{
  /** Tailwind width/max-width classes for the dialog panel. */
  panelClass?: string
  closeOnBackdrop?: boolean
  showClose?: boolean
}>(), {
  panelClass: 'w-full max-w-md',
  closeOnBackdrop: true,
  showClose: true,
})

const emit = defineEmits<{ close: [] }>()

/* Owns enter/leave animation: parents keep using v-if + @close, but the
   leave transition must finish before the parent is told to unmount us. */
const visible = ref(true)
function requestClose() { visible.value = false }

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') requestClose()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="ui-fade" appear @after-leave="emit('close')">
      <div
        v-if="visible"
        class="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
        @click.self="closeOnBackdrop && requestClose()"
      >
        <Transition name="ui-pop" appear>
          <div :class="['bg-[var(--c-surface)] border border-[var(--c-border-strong)] rounded-xl shadow-[var(--shadow-md)] flex flex-col max-h-[90vh]', panelClass]">
            <div v-if="$slots.header || showClose" class="flex items-center justify-between gap-3 px-6 py-4 border-b border-[var(--c-border)] shrink-0">
              <div class="flex-1 min-w-0 flex items-center justify-between gap-3">
                <slot name="header" />
              </div>
              <button
                v-if="showClose"
                @click="requestClose"
                title="Close"
                class="p-1 rounded-md text-[var(--c-text-3)] hover:text-[var(--c-text-1)] hover:bg-[var(--c-hover)] transition-colors shrink-0"
              >
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
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
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
