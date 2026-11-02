<script lang="ts" setup>
// daisyUI draws the chevron before every item that follows another one, so the
// separator keeps its place in the callers' markup without rendering anything.
</script>

<template>
  <li
    data-slot="breadcrumb-separator"
    role="presentation"
    aria-hidden="true"
    class="hidden"
  />
</template>
