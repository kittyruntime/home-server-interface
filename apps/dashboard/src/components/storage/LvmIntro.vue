<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { ChevronRightIcon, XIcon } from '@lucide/vue'
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
    <div v-if="!dismissed" class="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden relative mb-4 border-input bg-card p-4">
      <Button variant="ghost" size="icon-xs"
        title="Dismiss"
        aria-label="Dismiss LVM explanation"
        class="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
        @click="dismiss"
      >
        <XIcon class="w-4 h-4" aria-hidden="true" />
      </Button>

      <h3 class="text-sm font-semibold text-foreground pr-8">How LVM works</h3>

      <div class="mt-3 flex flex-col @2xl:flex-row @2xl:items-center gap-2 @2xl:gap-1">
        <template v-for="(s, i) in stages" :key="s.title">
          <div class="flex-1 min-w-0 rounded-xl border border-border bg-muted p-3">
            <p class="text-xs font-semibold text-purple-400">{{ s.title }}</p>
            <p class="mt-1 text-xs text-muted-foreground leading-snug">{{ s.caption }}</p>
          </div>
          <div v-if="i < stages.length - 1" class="flex items-center justify-center shrink-0 text-muted-foreground">
            <ChevronRightIcon class="w-4 h-4 rotate-90 @2xl:rotate-0" aria-hidden="true" />
          </div>
        </template>
      </div>

      <p class="mt-3 text-xs text-muted-foreground leading-snug">
        Use LVM to combine drives of different sizes into one pool, or to resize storage later
        without repartitioning. For a single disk you won't need to grow, formatting it directly
        under <strong class="text-foreground/80">Disks</strong> is simpler.
      </p>
    </div>
  </Transition>
</template>
