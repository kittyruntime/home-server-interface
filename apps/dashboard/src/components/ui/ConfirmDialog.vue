<script setup lang="ts">
import Modal from './Modal.vue'
import { confirmState } from '../../lib/confirm'

function resolve(v: boolean) {
  confirmState.value?.resolve(v)
  confirmState.value = null
}
</script>

<template>
  <Modal v-if="confirmState" panel-class="w-full max-w-sm" @close="resolve(false)">
    <template #header>
      <h3 class="text-sm font-semibold text-[var(--c-text-1)]">{{ confirmState.title ?? 'Confirm' }}</h3>
    </template>

    <p class="px-5 py-4 text-sm text-[var(--c-text-2)]">{{ confirmState.message }}</p>

    <template #footer>
      <div class="flex-1" />
      <button @click="resolve(false)" class="btn btn-ghost btn-sm">Cancel</button>
      <button
        @click="resolve(true)"
        :class="['btn btn-sm', confirmState.danger ? 'btn-danger' : 'btn-primary']"
      >{{ confirmState.confirmLabel ?? 'Confirm' }}</button>
    </template>
  </Modal>
</template>
