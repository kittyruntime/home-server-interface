<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
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

const { t } = useI18n()

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
        <Avatar class="size-8 text-xs">
          <AvatarFallback class="bg-primary font-bold text-primary-foreground">{{ initials }}</AvatarFallback>
        </Avatar>
        <span class="min-w-0">
          <span class="block truncate text-sm font-medium text-foreground">{{ currentUsername }}</span>
          <span class="block text-xs text-muted-foreground">{{ isAdmin ? t('account.administrator') : t('account.user') }}</span>
        </span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem @select="emit('profile')">
        <UserIcon />
        {{ t('account.profile') }}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <!-- Toggling keeps the menu open, like a settings row. -->
      <DropdownMenuItem class="justify-between" @select.prevent="setDesktopMode(!desktopMode)">
        <span class="flex items-center gap-2">
          <LayoutGridIcon />
          {{ t('account.desktopMode') }}
        </span>
        <Switch :model-value="desktopMode" tabindex="-1" aria-hidden="true" class="pointer-events-none" />
      </DropdownMenuItem>
      <DropdownMenuItem @select="emit('resetOrder')">
        <RotateCcwIcon />
        {{ t('account.resetSidebar') }}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" @select="emit('logout')">
        <LogOutIcon />
        {{ t('account.signOut') }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
