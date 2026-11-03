<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, inject, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { modalHostKey } from '../../lib/modal-host'
import { useNativeDialog } from '../../lib/native-dialog'

const { t } = useI18n()

/* App dialog shell on a native <dialog> (daisyUI modal). Parents keep the
   same contract as before: mount with v-if, listen to @close, which fires
   once the leave animation has finished. */
const props = withDefaults(defineProps<{
  /** Tailwind width/max-width classes for the dialog panel. */
  panelClass?: string
  /** Accessible name when there is no header slot to label the dialog. */
  label?: string
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

/* Inside a desktop window the modal stays within the window frame and only
   blocks that window: it is a positioned div (not the top layer, so other
   windows stay usable) that draws its own backdrop over the window body and
   traps Tab itself. */
const host = inject(modalHostKey, null)
const inWindow = computed(() => !!host?.value)
const titleId = useId()
const panel = ref<HTMLElement | null>(null)

const root = ref<HTMLElement | null>(null)
const { open, requestClose, finish, onCancel, onNativeClose, onPointerdown, onClick } = useNativeDialog(root, {
  canClose: () => !props.preventClose,
  closeOnBackdrop: () => props.closeOnBackdrop,
  onClosed: () => emit('close'),
})

/* In a window, Escape is heard on the window element (not on the document, so
   a modal never closes from another window), and a press inside the window
   that leaves focus on the page body brings it back to the panel. */
function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); requestClose() }
}
function onWindowPointerdown() {
  setTimeout(() => {
    if (panel.value && (!document.activeElement || document.activeElement === document.body)) panel.value.focus()
  })
}
let windowEl: HTMLElement | null = null
onMounted(() => {
  windowEl = host?.value?.parentElement ?? null
  windowEl?.addEventListener('keydown', onWindowKeydown)
  windowEl?.addEventListener('pointerdown', onWindowPointerdown)
})
onBeforeUnmount(() => {
  windowEl?.removeEventListener('keydown', onWindowKeydown)
  windowEl?.removeEventListener('pointerdown', onWindowPointerdown)
})

/* Focus the first field rather than the header's close button. */
onMounted(() => {
  if (!inWindow.value) return
  const target = panel.value?.querySelector<HTMLElement>('[autofocus], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [data-slot="dialog-body"] button:not(:disabled), [data-slot="dialog-footer"] button:not(:disabled), [href]')
  ;(target ?? panel.value)?.focus()
})

function onPanelKeydown(event: KeyboardEvent) {
  const el = panel.value
  if (!inWindow.value || !el) return
  if (event.key !== 'Tab') return
  const focusable = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
  if (!focusable.length) { event.preventDefault(); el.focus(); return }
  const first = focusable[0]!, last = focusable[focusable.length - 1]!
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}

const panelClasses = computed(() => cn(
  'pointer-events-auto flex flex-col bg-base-100 text-foreground border outline-none',
  inWindow.value
    ? 'rounded-xl shadow-lg max-h-[90%]'
    : 'modal-box p-0 max-h-[92dvh] sm:max-h-[90dvh]',
  props.panelClass,
))

/* Lets wrappers close with the leave animation instead of unmounting
   abruptly via their own v-if. */
defineExpose({ requestClose })
</script>

<template>
  <Teleport :to="inWindow ? host : 'body'">
    <component
      :is="inWindow ? 'div' : 'dialog'"
      ref="root"
      :class="inWindow
        ? 'pointer-events-none absolute inset-0 z-50 flex items-center justify-center p-4'
        : ['modal modal-bottom sm:modal-middle justify-items-center sm:p-4 [&>:not(.modal-box)]:absolute', { 'pointer-events-none opacity-0': !open }]"
      :style="inWindow ? undefined : { transitionDuration: 'var(--dur-base)' }"
      :aria-labelledby="!inWindow && $slots.header ? titleId : undefined"
      :aria-label="!inWindow && !$slots.header ? label : undefined"
      @cancel="onCancel"
      @close="onNativeClose"
      @pointerdown="onPointerdown"
      @click="onClick"
    >
      <Transition v-if="inWindow" name="ui-fade" appear>
        <div v-if="open" class="pointer-events-auto absolute inset-0 -z-10 bg-black/50" @mousedown.prevent @click="closeOnBackdrop && requestClose()" />
      </Transition>
      <Transition name="ui-pop" appear @after-leave="finish">
        <!-- v-show, not v-if: the panel keeps its content through the leave
             transition, and unmounting it mid-leave breaks Vue's insertion anchor. -->
        <div
          v-show="open"
          ref="panel"
          :role="inWindow ? 'dialog' : undefined"
          :aria-modal="inWindow ? 'true' : undefined"
          :aria-labelledby="inWindow && $slots.header ? titleId : undefined"
          :aria-label="inWindow && !$slots.header ? label : undefined"
          tabindex="-1"
          :class="panelClasses"
          @keydown="onPanelKeydown"
        >
          <div v-if="$slots.header || showClose" class="flex items-center justify-between gap-3 px-6 py-4 border-b shrink-0">
            <div :id="titleId" class="flex-1 min-w-0 flex items-center justify-between gap-3">
              <slot name="header" />
            </div>
            <Button
              v-if="showClose"
              variant="ghost"
              size="icon-sm"
              class="shrink-0 text-muted-foreground"
              :tooltip="t('ui.shared.Modal.close')"
              :aria-label="t('ui.shared.Modal.closeDialog')"
              :disabled="preventClose"
              @click="requestClose"
            >
              <XIcon />
            </Button>
          </div>

          <!-- Non-scrolling region between header and body, e.g. a tab bar. -->
          <div v-if="$slots.subheader" class="shrink-0">
            <slot name="subheader" />
          </div>

          <div data-slot="dialog-body" class="flex-1 overflow-y-auto min-h-0">
            <slot />
          </div>

          <div v-if="$slots.footer" data-slot="dialog-footer" class="px-4 sm:px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t flex flex-wrap items-center gap-2 shrink-0">
            <slot name="footer" />
          </div>
        </div>
      </Transition>
    </component>
  </Teleport>
</template>
