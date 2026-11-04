<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref, useId } from 'vue'
import { confirmState } from '../../lib/confirm'
import { useNativeDialog } from '../../lib/native-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

const { t } = useI18n()

/* One confirmation prompt on a native <dialog>. ConfirmDialog mounts a fresh
   one per request (keyed by id), so an answer, Escape or Cancel closes this
   instance through its leave transition and clears the shared state. */
const myId = confirmState.value?.id
const titleId = useId()
const descId = useId()
const optedOut = ref(false)

const el = ref<HTMLElement | null>(null)
const { open, requestClose, finish, onNativeClose } = useNativeDialog(el, {
  onClosed() {
    confirmState.value?.resolve(false)
    if (confirmState.value?.id === myId) confirmState.value = null
  },
})

/* Settle the promise right away so the caller proceeds, then animate out.
   A second answer is ignored. */
function choose(v: boolean) {
  if (!open.value) return
  if (v && optedOut.value) confirmState.value?.onOptOut?.()
  confirmState.value?.resolve(v)
  requestClose()
}
</script>

<template>
  <dialog
    ref="el"
    role="alertdialog"
    :aria-labelledby="titleId"
    :aria-describedby="descId"
    :class="['modal modal-bottom sm:modal-middle justify-items-center sm:p-4', { 'pointer-events-none opacity-0': !open }]"
    :style="{ transitionDuration: 'var(--dur-base)' }"
    @cancel.prevent="choose(false)"
    @close="onNativeClose"
  >
    <Transition name="ui-pop" appear @after-leave="finish">
      <div v-if="open && confirmState" class="modal-box flex w-full flex-col gap-4 sm:max-w-sm">
        <div class="flex flex-col gap-2">
          <h2 :id="titleId" class="text-lg font-semibold">{{ confirmState.title ?? 'Confirm' }}</h2>
          <p :id="descId" class="text-sm text-base-content/70">{{ confirmState.message }}</p>
        </div>
        <label v-if="confirmState.optOutLabel" class="flex items-center gap-2 text-sm text-base-content/70">
          <Checkbox v-model="optedOut" />
          {{ confirmState.optOutLabel }}
        </label>
        <div class="modal-action mt-0 flex-col-reverse sm:flex-row">
          <Button variant="outline" autofocus @click="choose(false)">{{ confirmState.cancelLabel ?? t('ui.shared.ConfirmDialog.cancel') }}</Button>
          <Button :variant="confirmState.danger ? 'destructive' : 'default'" @click="choose(true)">{{ confirmState.confirmLabel ?? 'Confirm' }}</Button>
        </div>
      </div>
    </Transition>
  </dialog>
</template>
