<script setup lang="ts">
import { ref } from 'vue'

const DISMISS_KEY = 'lvm-intro-dismissed'
const dismissed = ref(localStorage.getItem(DISMISS_KEY) === '1')

function dismiss() {
  dismissed.value = true
  localStorage.setItem(DISMISS_KEY, '1')
}

const stages = [
  {
    title: 'Disks',
    caption: 'Pick one or more disks, partitions or RAID arrays.',
  },
  {
    title: 'Volume Group',
    caption: 'They’re pooled together into one flexible pool (VG).',
  },
  {
    title: 'Logical Volumes',
    caption: 'Carve out resizable volumes (LVs) from the pool as you need them.',
  },
]
</script>

<template>
  <Transition name="ui-fade">
    <div v-if="!dismissed" class="panel-card relative mb-4 border-[var(--c-border-strong)] bg-[var(--c-surface)] p-4">
      <button
        title="Dismiss"
        aria-label="Dismiss LVM explanation"
        class="absolute right-3 top-3 grid h-6 w-6 place-items-center rounded-md text-[var(--c-text-3)] hover:bg-[var(--c-hover)] hover:text-[var(--c-text-1)] transition-colors"
        @click="dismiss"
      >
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      <h3 class="text-sm font-semibold text-[var(--c-text-1)] pr-8">How LVM works</h3>

      <div class="mt-3 flex flex-col @2xl:flex-row @2xl:items-center gap-2 @2xl:gap-1">
        <template v-for="(s, i) in stages" :key="s.title">
          <div class="flex-1 min-w-0 rounded-xl border border-[var(--c-border)] bg-[var(--c-surface-alt)] p-3">
            <p class="text-xs font-semibold text-purple-400">{{ s.title }}</p>
            <p class="mt-1 text-xs text-[var(--c-text-3)] leading-snug">{{ s.caption }}</p>
          </div>
          <div v-if="i < stages.length - 1" class="flex items-center justify-center shrink-0 text-[var(--c-text-3)]">
            <svg class="w-4 h-4 rotate-90 @2xl:rotate-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
            </svg>
          </div>
        </template>
      </div>

      <p class="mt-3 text-xs text-[var(--c-text-3)] leading-snug">
        Use LVM to combine drives of different sizes into one pool, or to resize storage later
        without repartitioning. For a single disk you won't need to grow, formatting it directly
        under <strong class="text-[var(--c-text-2)]">Disks</strong> is simpler.
      </p>
    </div>
  </Transition>
</template>
