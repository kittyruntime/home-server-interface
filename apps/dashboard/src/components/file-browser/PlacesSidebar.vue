<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { InfoIcon } from '@lucide/vue'
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
}>()

defineEmits<{ select: [place: Place]; openProperties: [place: Place] }>()
</script>

<template>
  <SidebarProvider class="min-h-0 w-auto shrink-0" :style="{ '--sidebar-width': '11rem' }">
    <Sidebar collapsible="none" class="h-full border-r">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{{ t('ui.files.PlacesSidebar.places') }}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu :aria-label="t('ui.files.PlacesSidebar.places')">
              <SidebarMenuItem v-for="place in places" :key="place.id">
                <SidebarMenuButton :is-active="activePlaceId === place.id" @click.stop="$emit('select', place)">
                  <PlaceIcon :icon="place.icon" :root="place.id === '__root__'" class="size-4 text-sm" />
                  <span>{{ place.name }}</span>
                </SidebarMenuButton>
                <SidebarMenuAction show-on-hover :aria-label="`Properties of ${place.name}`" @click.stop="$emit('openProperties', place)">
                  <InfoIcon aria-hidden="true" />
                </SidebarMenuAction>
              </SidebarMenuItem>
            </SidebarMenu>
            <p v-if="places.length === 0" class="text-xs text-muted-foreground px-2 py-2 leading-snug">
              {{ t('ui.files.PlacesSidebar.noPlacesYetAskAn') }}
            </p>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  </SidebarProvider>
</template>
