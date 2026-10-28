<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import { avatarGradient } from '../lib/avatar'

// A user's initials on their gradient, on the shadcn-vue avatar.
const props = defineProps<{ username: string; class?: HTMLAttributes['class'] }>()
</script>

<template>
  <Avatar :class="cn('select-none', props.class)">
    <AvatarFallback :class="['rounded-[inherit] bg-gradient-to-br font-bold text-white', avatarGradient(username)]">
      {{ username.slice(0, 2).toUpperCase() }}
    </AvatarFallback>
  </Avatar>
</template>
