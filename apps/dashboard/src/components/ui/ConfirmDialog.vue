<script setup lang="ts">
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

/* The dialog stays open while it animates out; the state is cleared once the
   content has unmounted (close-auto-focus), and a request that replaced this
   one re-mounts the content through :key. */
const open = ref(false)
watch(() => confirmState.value?.id, id => { open.value = id !== undefined }, { immediate: true })

/* Settle the promise right away so the caller proceeds. */
function choose(v: boolean) {
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
      <AlertDialogFooter>
        <AlertDialogCancel @click="choose(false)">Cancel</AlertDialogCancel>
        <AlertDialogAction
          :class="confirmState.danger ? buttonVariants({ variant: 'destructive' }) : undefined"
          @click="choose(true)"
        >{{ confirmState.confirmLabel ?? 'Confirm' }}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
