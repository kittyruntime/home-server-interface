<script setup lang="ts">
import { confirmState } from '../../lib/confirm'
import ConfirmDialogBox from './ConfirmDialogBox.vue'
</script>

<template>
  <!-- Keyed by request: a confirm() that replaces one still animating out
       re-mounts the dialog. -->
  <ConfirmDialogBox v-if="confirmState" :key="confirmState.id" />
</template>
