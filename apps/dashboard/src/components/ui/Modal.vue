<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useEscLayer } from '../../lib/escLayer'
import { modalHostKey } from '../../lib/modal-host'

const props = withDefaults(defineProps<{
  /** Tailwind width/max-width classes for the dialog panel. */
  panelClass?: string
  closeOnBackdrop?: boolean
  showClose?: boolean
  /** Block Escape/backdrop/X while a critical operation runs (e.g. formatting). */
  preventClose?: boolean
}>(), {
  panelClass: 'w-full max-w-md',
  closeOnBackdrop: true,
  showClose: true,
  preventClose: false,
})

const emit = defineEmits<{ close: [] }>()

/* Owns enter/leave animation: parents keep using v-if + @close, but the
   leave transition must finish before the parent is told to unmount us. */
const visible = ref(true)
const panel = ref<HTMLElement | null>(null)
let previouslyFocused: HTMLElement | null = null
function requestClose() {
  if (props.preventClose) return
  visible.value = false
}

useEscLayer(requestClose)

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !panel.value) return
  const focusable = [...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
  if (!focusable.length) { event.preventDefault(); panel.value.focus(); return }
  const first = focusable[0]!, last = focusable[focusable.length - 1]!
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}

onMounted(() => {
  previouslyFocused = document.activeElement as HTMLElement | null
  void nextTick(() => {
    const target = panel.value?.querySelector<HTMLElement>('[autofocus], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [href]')
    ;(target ?? panel.value)?.focus()
  })
})
onUnmounted(() => previouslyFocused?.focus())

/* Inside a desktop window the modal stays within the window frame. */
const host = inject(modalHostKey, null)
const teleportTarget = computed(() => host?.value ?? 'body')

/* Lets wrappers (ConfirmDialog) close with the leave animation instead of
   unmounting abruptly via their own v-if. */
defineExpose({ requestClose })
</script>

<template>
  <Teleport :to="teleportTarget">
    <Transition name="ui-fade" appear @after-leave="emit('close')">
      <div
        v-if="visible"
        :class="[host ? 'absolute items-center justify-center p-4' : 'fixed items-end justify-center p-0 sm:items-center sm:p-4', 'inset-0 z-50 bg-black/80 flex']"
        @click.self="closeOnBackdrop && requestClose()"
      >
        <Transition name="ui-pop" appear>
          <!-- v-if mirrors the backdrop's so the panel plays its own leave pop
               (unmounting via the parent alone would skip it). -->
          <!-- max-h is a % so it tracks the host (window body or viewport). -->
          <div ref="panel" v-if="visible" role="dialog" aria-modal="true" tabindex="-1" @keydown="onKeydown" :class="['bg-card border border-input rounded-t-2xl sm:rounded-xl shadow-lg flex flex-col max-h-[92dvh] sm:max-h-[90%] outline-none', panelClass]">
            <div v-if="$slots.header || showClose" class="flex items-center justify-between gap-3 px-6 py-4 border-b border-border shrink-0">
              <div class="flex-1 min-w-0 flex items-center justify-between gap-3">
                <slot name="header" />
              </div>
              <button
                v-if="showClose"
                @click="requestClose"
                title="Close"
                aria-label="Close dialog"
                class="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
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

            <div v-if="$slots.footer" class="px-4 sm:px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-border flex flex-wrap items-center gap-2 shrink-0">
              <slot name="footer" />
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
