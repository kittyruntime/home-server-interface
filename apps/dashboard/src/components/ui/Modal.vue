<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, inject, ref } from 'vue'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { modalHostKey } from '../../lib/modal-host'

const { t } = useI18n()

/* App dialog shell on top of the shadcn-vue / Reka UI dialog. Parents keep
   the same contract as before: mount with v-if, listen to @close, which
   fires once the leave animation has finished. */
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

const open = ref(true)
const panel = ref<InstanceType<typeof DialogContent> | null>(null)

function requestClose() {
  if (props.preventClose) return
  open.value = false
}

/* Inside a desktop window the modal stays within the window frame and only
   blocks that window: the dialog is non-modal for Reka (other windows stay
   usable) and draws its own backdrop over the window body. */
const host = inject(modalHostKey, null)
const inWindow = computed(() => !!host?.value)
const teleportTarget = computed(() => host?.value ?? 'body')

function onOutside(event: Event) {
  if (inWindow.value || !props.closeOnBackdrop || props.preventClose) event.preventDefault()
}

function onEscape(event: KeyboardEvent) {
  if (props.preventClose) event.preventDefault()
}

function panelEl(): HTMLElement | null {
  return (panel.value?.$el as HTMLElement | undefined) ?? null
}

/* Focus the first field rather than the header's close button. */
function onOpenAutoFocus(event: Event) {
  event.preventDefault()
  const el = panelEl()
  const target = el?.querySelector<HTMLElement>('[autofocus], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [data-slot="dialog-body"] button:not(:disabled), [data-slot="dialog-footer"] button:not(:disabled), [href]')
  ;(target ?? el)?.focus()
}

/* A non-modal dialog does not trap focus: keep Tab inside the panel. */
function onKeydown(event: KeyboardEvent) {
  const el = panelEl()
  if (!inWindow.value || event.key !== 'Tab' || !el) return
  const focusable = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
  if (!focusable.length) { event.preventDefault(); el.focus(); return }
  const first = focusable[0]!, last = focusable[focusable.length - 1]!
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}

/* Fires when the panel unmounts, after its leave animation. Only a close we
   asked for is reported: a parent unmounting us directly already knows. */
function onClosed() {
  if (!open.value) emit('close')
}

/* Lets wrappers close with the leave animation instead of unmounting
   abruptly via their own v-if. */
defineExpose({ requestClose })
</script>

<template>
  <DialogRoot :open="open" :modal="!inWindow" @update:open="value => { if (!value) requestClose() }">
    <DialogPortal :to="teleportTarget">
      <DialogOverlay
        v-if="!inWindow"
        class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
      />
      <Transition name="ui-fade" appear>
        <div v-if="inWindow && open" class="absolute inset-0 z-50 bg-black/50" @click="closeOnBackdrop && requestClose()" />
      </Transition>
      <!-- Positioning layer: centers the panel (bottom sheet under 640px in
           fullscreen mode); clicks fall through to the backdrop. -->
      <div
        :class="[
          inWindow ? 'absolute items-center p-4' : 'fixed items-end p-0 sm:items-center sm:p-4',
          'pointer-events-none inset-0 z-50 flex justify-center',
        ]"
      >
        <DialogContent
          ref="panel"
          :aria-describedby="undefined"
          :class="cn(
            'pointer-events-auto flex flex-col bg-background text-foreground border shadow-lg outline-none',
            'rounded-t-xl sm:rounded-xl max-h-[92dvh] sm:max-h-[90%]',
            'duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            panelClass,
          )"
          @open-auto-focus="onOpenAutoFocus"
          @close-auto-focus="onClosed"
          @escape-key-down="onEscape"
          @pointer-down-outside="onOutside"
          @interact-outside="onOutside"
          @keydown="onKeydown"
        >
          <div v-if="$slots.header || showClose" class="flex items-center justify-between gap-3 px-6 py-4 border-b shrink-0">
            <DialogTitle as="div" class="flex-1 min-w-0 flex items-center justify-between gap-3">
              <slot name="header" />
            </DialogTitle>
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
        </DialogContent>
      </div>
    </DialogPortal>
  </DialogRoot>
</template>
