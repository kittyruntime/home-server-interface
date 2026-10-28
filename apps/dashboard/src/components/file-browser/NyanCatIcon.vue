<script setup lang="ts">
// Easter egg: a pixel cat with a rainbow trail for anything named "nyan".
const RAINBOW = ['#ff1f1f', '#ff9a1f', '#ffe61f', '#3ee03e', '#1fa3ff', '#7a3dff']
</script>

<template>
  <svg viewBox="0 0 32 20" shape-rendering="crispEdges" role="img" aria-label="Nyan cat">
    <!-- Rainbow trail, wavy -->
    <template v-for="(color, i) in RAINBOW" :key="color">
      <rect x="0" :y="4 + i * 2" width="4" height="2" :fill="color" />
      <rect x="4" :y="5 + i * 2" width="4" height="2" :fill="color" />
      <rect x="8" :y="4 + i * 2" width="3" height="2" :fill="color" />
    </template>
    <!-- Tail -->
    <rect x="8" y="10" width="3" height="2" fill="#9a9a9a" />
    <!-- Legs -->
    <rect x="11" y="16" width="2" height="2" fill="#9a9a9a" />
    <rect x="14" y="17" width="2" height="2" fill="#9a9a9a" />
    <rect x="19" y="17" width="2" height="2" fill="#9a9a9a" />
    <rect x="22" y="16" width="2" height="2" fill="#9a9a9a" />
    <!-- Pastry body -->
    <rect x="10" y="2" width="15" height="15" rx="2" fill="#f6c58f" />
    <rect x="11" y="3" width="13" height="13" rx="1" fill="#ff99e0" />
    <rect x="13" y="5" width="1" height="1" fill="#e8337d" />
    <rect x="17" y="4" width="1" height="1" fill="#e8337d" />
    <rect x="21" y="6" width="1" height="1" fill="#e8337d" />
    <rect x="14" y="9" width="1" height="1" fill="#e8337d" />
    <rect x="12" y="13" width="1" height="1" fill="#e8337d" />
    <rect x="16" y="12" width="1" height="1" fill="#e8337d" />
    <!-- Head and ears -->
    <rect x="18" y="8" width="11" height="8" rx="1" fill="#9a9a9a" />
    <rect x="18" y="6" width="2" height="2" fill="#9a9a9a" />
    <rect x="20" y="7" width="1" height="1" fill="#9a9a9a" />
    <rect x="27" y="6" width="2" height="2" fill="#9a9a9a" />
    <rect x="26" y="7" width="1" height="1" fill="#9a9a9a" />
    <!-- Face -->
    <rect x="20" y="10" width="2" height="2" fill="#222" />
    <rect x="20" y="10" width="1" height="1" fill="#fff" />
    <rect x="25" y="10" width="2" height="2" fill="#222" />
    <rect x="25" y="10" width="1" height="1" fill="#fff" />
    <rect x="19" y="13" width="2" height="1" fill="#ff8fb1" />
    <rect x="26" y="13" width="2" height="1" fill="#ff8fb1" />
    <rect x="22" y="13" width="3" height="1" fill="#222" />
    <rect x="23" y="12" width="1" height="1" fill="#222" />
  </svg>
</template>
