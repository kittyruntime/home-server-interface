<script setup lang="ts">
// The HSI mark: a copper tile holding the bays of a home server, the last one
// lit. Drawn from the theme, so it follows the accent the owner picks.
</script>

<template>
  <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect x="2" y="2" width="28" height="28" rx="8" fill="var(--color-primary)" />
    <rect x="8" y="8.5" width="16" height="3.5" rx="1.75" fill="var(--color-primary-content)" />
    <rect x="8" y="14.25" width="16" height="3.5" rx="1.75" fill="var(--color-primary-content)" opacity="0.6" />
    <rect x="8" y="20" width="10" height="3.5" rx="1.75" fill="var(--color-primary-content)" opacity="0.6" />
    <circle cx="22.25" cy="21.75" r="1.75" fill="var(--color-primary-content)" />
  </svg>
</template>
