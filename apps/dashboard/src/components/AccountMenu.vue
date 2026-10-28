<script setup lang="ts">
import { computed } from 'vue'
import { LayoutGridIcon, LogOutIcon, RotateCcwIcon, UserIcon } from '@lucide/vue'
import { useAuth } from '../lib/auth'
import { useDesktop } from '../lib/desktop'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'

/* Account menu opened from the avatar, in the sidebar and in the mobile nav. */
defineProps<{ side?: 'top' | 'right' }>()
const emit = defineEmits<{ profile: []; resetOrder: []; logout: [] }>()

const { currentUsername, isAdmin } = useAuth()
const { desktopMode, setDesktopMode } = useDesktop()

const initials = computed(() => (currentUsername.value ?? 'U').slice(0, 2).toUpperCase())
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <slot :initials="initials" />
    </DropdownMenuTrigger>
    <DropdownMenuContent :side="side ?? 'right'" align="end" :side-offset="8" class="w-56">
      <DropdownMenuLabel class="flex items-center gap-3 py-2 font-normal">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
          {{ initials }}
        </span>
        <span class="min-w-0">
          <span class="block truncate text-sm font-medium text-foreground">{{ currentUsername }}</span>
          <span class="block text-xs text-muted-foreground">{{ isAdmin ? 'Administrator' : 'User' }}</span>
        </span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem @select="emit('profile')">
        <UserIcon />
        Profile
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <!-- Toggling keeps the menu open, like a settings row. -->
      <DropdownMenuItem class="justify-between" @select.prevent="setDesktopMode(!desktopMode)">
        <span class="flex items-center gap-2">
          <LayoutGridIcon />
          Desktop mode
        </span>
        <Switch :model-value="desktopMode" tabindex="-1" aria-hidden="true" class="pointer-events-none" />
      </DropdownMenuItem>
      <DropdownMenuItem @select="emit('resetOrder')">
        <RotateCcwIcon />
        Reset sidebar order
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" @select="emit('logout')">
        <LogOutIcon />
        Sign out
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
