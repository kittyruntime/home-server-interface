<script setup lang="ts">
import { ref, watch } from 'vue'
import { useSystemNotifications } from '../lib/systemNotifications'
import NotificationMenu from './NotificationMenu.vue'
import Tip from './ui/Tip.vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/* Activity panel opened from the bell, in the sidebar and in the mobile nav. */
defineProps<{ side?: 'top' | 'right'; tooltip?: string }>()

const open = ref(false)
const { refresh } = useSystemNotifications()

// Refreshing on close keeps the badge accurate right after the user has read
// the list, without waiting for the next 60s poll.
watch(open, value => { if (!value) void refresh() })
</script>

<template>
  <Popover v-model:open="open">
    <!-- The tooltip wraps the trigger: a Button with its own tooltip is not the
         root element, so the panel would have nothing to anchor to. -->
    <Tip :text="tooltip">
      <PopoverTrigger as-child>
        <slot :open="open" />
      </PopoverTrigger>
    </Tip>
    <PopoverContent :side="side ?? 'right'" align="end" :side-offset="8" class="w-[min(24rem,calc(100vw-1rem))] overflow-hidden p-0">
      <NotificationMenu @close="open = false" />
    </PopoverContent>
  </Popover>
</template>
