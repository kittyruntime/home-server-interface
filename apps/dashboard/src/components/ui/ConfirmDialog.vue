<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ref, watch } from 'vue'
import { confirmState } from '../../lib/confirm'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

const { t } = useI18n()

/* The dialog stays open while it animates out; the state is cleared once the
   content has unmounted (close-auto-focus), and a request that replaced this
   one re-mounts the content through :key. */
const open = ref(false)
const optedOut = ref(false)
watch(() => confirmState.value?.id, id => { open.value = id !== undefined; optedOut.value = false }, { immediate: true })

/* Settle the promise right away so the caller proceeds. */
function choose(v: boolean) {
  if (v && optedOut.value) confirmState.value?.onOptOut?.()
  confirmState.value?.resolve(v)
  open.value = false
}

function onOpenChange(value: boolean) {
  if (!value) choose(false)
}

function onClosed() {
  if (open.value) return
  confirmState.value?.resolve(false)
  confirmState.value = null
}
</script>

<template>
  <AlertDialog :open="open" @update:open="onOpenChange">
    <AlertDialogContent v-if="confirmState" :key="confirmState.id" class="sm:max-w-sm" @close-auto-focus="onClosed">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ confirmState.title ?? 'Confirm' }}</AlertDialogTitle>
        <AlertDialogDescription>{{ confirmState.message }}</AlertDialogDescription>
      </AlertDialogHeader>
      <label v-if="confirmState.optOutLabel" class="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox v-model="optedOut" />
        {{ confirmState.optOutLabel }}
      </label>
      <AlertDialogFooter>
        <AlertDialogCancel @click="choose(false)">{{ t('ui.shared.ConfirmDialog.cancel') }}</AlertDialogCancel>
        <AlertDialogAction
          :class="confirmState.danger ? buttonVariants({ variant: 'destructive' }) : undefined"
          @click="choose(true)"
        >{{ confirmState.confirmLabel ?? 'Confirm' }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
