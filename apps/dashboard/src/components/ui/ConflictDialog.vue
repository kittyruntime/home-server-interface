<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref, useId } from 'vue'
import { conflictQuestion, type ConflictChoice } from '../../lib/conflicts'
import { useNativeDialog } from '../../lib/native-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

/* "Films already exists in Archives": replace, keep both or skip, for this
   item or every remaining conflict. One per question (keyed by id), like
   ConfirmDialogBox. Escape cancels the whole transfer. */
const { t } = useI18n()
const q = conflictQuestion.value
const titleId = useId()
const descId = useId()
const all = ref(false)
const answered = ref(false)

const el = ref<HTMLElement | null>(null)
const { open, requestClose, finish, onNativeClose } = useNativeDialog(el, {
  onClosed() {
    if (!answered.value) q?.resolve({ choice: 'cancel', all: false })
    if (conflictQuestion.value?.id === q?.id) conflictQuestion.value = null
  },
})

function choose(choice: ConflictChoice | 'cancel') {
  if (!open.value || answered.value) return
  answered.value = true
  q?.resolve({ choice, all: all.value })
  requestClose()
}

const dirName = (path: string) => path.split('/').pop() || path
</script>

<template>
  <dialog
    ref="el"
    role="alertdialog"
    :aria-labelledby="titleId"
    :aria-describedby="descId"
    :class="['modal modal-bottom sm:modal-middle justify-items-center sm:p-4', { 'pointer-events-none opacity-0': !open }]"
    :style="{ transitionDuration: 'var(--dur-base)' }"
    @cancel.prevent="choose('cancel')"
    @close="onNativeClose"
  >
    <Transition name="ui-pop" appear @after-leave="finish">
      <div v-if="open && q" class="modal-box flex w-full flex-col gap-4 sm:max-w-lg">
        <div class="flex flex-col gap-2">
          <h2 :id="titleId" class="text-lg font-semibold">{{ t('files.conflict.title') }}</h2>
          <p :id="descId" class="text-sm text-base-content/70">
            {{ t(q.isDir ? 'files.conflict.messageFolder' : 'files.conflict.messageFile', { name: q.name, dir: dirName(q.dir) }) }}
          </p>
        </div>
        <label v-if="q.remaining > 1" class="flex items-center gap-2 text-sm text-base-content/70">
          <Checkbox v-model="all" />
          {{ t('files.conflict.applyToAll', { count: q.remaining }) }}
        </label>
        <!-- Phone: stacked, the safe choice first. Wider: Cancel on the left,
             the three answers on the right. -->
        <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Button variant="ghost" class="order-last sm:order-first" @click="choose('cancel')">{{ t('ui.shared.ConfirmDialog.cancel') }}</Button>
          <div class="hidden flex-1 sm:block" />
          <Button variant="outline" class="sm:order-none" @click="choose('skip')">{{ t('files.conflict.skip') }}</Button>
          <Button variant="destructive" @click="choose('replace')">{{ t('files.conflict.replace') }}</Button>
          <Button variant="default" class="order-first sm:order-none" autofocus @click="choose('keep')">{{ t('files.conflict.keepBoth') }}</Button>
        </div>
      </div>
    </Transition>
  </dialog>
</template>
