<script setup lang="ts">
import { ref } from 'vue'
import Modal from './Modal.vue'
import { confirmState } from '../../lib/confirm'

const modal = ref<InstanceType<typeof Modal> | null>(null)

/* Settle the promise right away so the caller proceeds, then let the Modal
   play its leave animation; @close clears the state (its resolve is a no-op
   by then, and a request that replaced this one is protected by :key). */
function choose(v: boolean) {
  confirmState.value?.resolve(v)
  modal.value?.requestClose()
}

function onClose() {
  confirmState.value?.resolve(false)
  confirmState.value = null
}
</script>

<template>
  <Modal v-if="confirmState" ref="modal" :key="confirmState.id" panel-class="w-full max-w-sm" @close="onClose">
    <template #header>
      <h3 class="text-sm font-semibold text-[var(--c-text-1)]">{{ confirmState.title ?? 'Confirm' }}</h3>
    </template>

    <p class="px-5 py-4 text-sm text-[var(--c-text-2)]">{{ confirmState.message }}</p>

    <template #footer>
      <div class="flex-1" />
      <button @click="choose(false)" class="btn btn-ghost btn-sm">Cancel</button>
      <button
        @click="choose(true)"
        :class="['btn btn-sm', confirmState.danger ? 'btn-danger' : 'btn-primary']"
      >{{ confirmState.confirmLabel ?? 'Confirm' }}</button>
    </template>
  </Modal>
</template>
