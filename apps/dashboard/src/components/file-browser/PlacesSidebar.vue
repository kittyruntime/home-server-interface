<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { InfoIcon, SettingsIcon } from '@lucide/vue'
import PlaceIcon from '../PlaceIcon.vue'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar'

const { t } = useI18n()
type Place = { id: string; name: string; path: string; icon?: string | null }

defineProps<{
  places: Place[]
  activePlaceId: string | null
  settingsActive?: boolean
}>()

defineEmits<{ select: [place: Place]; openProperties: [place: Place]; openSettings: [] }>()
</script>

<template>
  <SidebarProvider class="min-h-0 w-auto shrink-0" :style="{ '--sidebar-width': '11rem' }">
    <Sidebar class="h-full border-r">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{{ t('ui.files.PlacesSidebar.places') }}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu :aria-label="t('ui.files.PlacesSidebar.places')">
              <SidebarMenuItem v-for="place in places" :key="place.id">
                <SidebarMenuButton :is-active="!settingsActive && activePlaceId === place.id" :aria-current="!settingsActive && activePlaceId === place.id ? 'page' : undefined" @click.stop="$emit('select', place)">
                  <PlaceIcon :icon="place.icon" :root="place.id === '__root__'" class="size-4 text-sm text-base-content/70" />
                  <span>{{ place.name }}</span>
                </SidebarMenuButton>
                <SidebarMenuAction show-on-hover :aria-label="`Properties of ${place.name}`" @click.stop="$emit('openProperties', place)">
                  <InfoIcon aria-hidden="true" />
                </SidebarMenuAction>
              </SidebarMenuItem>
            </SidebarMenu>
            <p v-if="places.length === 0" class="text-xs text-base-content/70 px-2 py-2 leading-snug">
              {{ t('ui.files.PlacesSidebar.noPlacesYetAskAn') }}
            </p>
          </SidebarGroupContent>
        </SidebarGroup>
        <!-- The file manager's settings (display, shared links), apart from the places. -->
        <SidebarGroup class="mt-auto border-t border-base-300">
          <SidebarGroupContent>
            <SidebarMenu :aria-label="t('ui.files.PlacesSidebar.settings')">
              <SidebarMenuItem>
                <SidebarMenuButton :is-active="settingsActive" :aria-current="settingsActive ? 'page' : undefined" @click.stop="$emit('openSettings')">
                  <SettingsIcon class="size-4" aria-hidden="true" />
                  <span>{{ t('ui.files.PlacesSidebar.settings') }}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  </SidebarProvider>
</template>
