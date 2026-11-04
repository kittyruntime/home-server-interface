<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { InfoIcon, LinkIcon, SlidersHorizontalIcon } from '@lucide/vue'
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
  sharedActive?: boolean
}>()

defineEmits<{ select: [place: Place]; openProperties: [place: Place]; openShared: []; openDisplaySettings: [] }>()
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
                <SidebarMenuButton :is-active="!sharedActive && activePlaceId === place.id" :aria-current="!sharedActive && activePlaceId === place.id ? 'page' : undefined" @click.stop="$emit('select', place)">
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
        <!-- File manager settings, kept apart from the places at the bottom. -->
        <SidebarGroup class="mt-auto border-t border-base-300">
          <SidebarGroupLabel>{{ t('ui.files.PlacesSidebar.settings') }}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu :aria-label="t('ui.files.PlacesSidebar.settings')">
              <SidebarMenuItem>
                <SidebarMenuButton :is-active="sharedActive" :aria-current="sharedActive ? 'page' : undefined" @click.stop="$emit('openShared')">
                  <LinkIcon class="size-4" aria-hidden="true" />
                  <span>{{ t('ui.files.PlacesSidebar.sharedLinks') }}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton @click.stop="$emit('openDisplaySettings')">
                  <SlidersHorizontalIcon class="size-4" aria-hidden="true" />
                  <span>{{ t('files.display.title') }}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  </SidebarProvider>
</template>
