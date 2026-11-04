<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDownIcon, ArrowUpIcon, BookmarkIcon, EllipsisIcon, InfoIcon, PencilIcon, SettingsIcon, XIcon } from '@lucide/vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { bookmarkLabel, type Bookmark } from '../../lib/bookmarks'
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

const props = defineProps<{
  places: Place[]
  activePlaceId: string | null
  settingsActive?: boolean
  /** Bookmarked folders (#199), and the ones that are gone or no longer reachable. */
  bookmarks?: Bookmark[]
  missingBookmarks?: Set<string>
  currentPath?: string | null
}>()

// On a bookmarked folder the bookmark is the highlighted entry, not its place.
const onBookmark = computed(() => !!props.currentPath && !!props.bookmarks?.some(b => b.path === props.currentPath))
const placeActive = (id: string) => !props.settingsActive && !onBookmark.value && props.activePlaceId === id

defineEmits<{
  select: [place: Place]; openProperties: [place: Place]; openSettings: []
  openBookmark: [path: string]; renameBookmark: [bookmark: Bookmark]; moveBookmark: [path: string, delta: -1 | 1]; removeBookmark: [path: string]
}>()
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
                <SidebarMenuButton :is-active="placeActive(place.id)" :aria-current="placeActive(place.id) ? 'page' : undefined" @click.stop="$emit('select', place)">
                  <PlaceIcon :icon="place.icon" :root="place.id === '__root__'" class="size-4 text-sm opacity-70" />
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
        <!-- Bookmarked folders (#199) -->
        <SidebarGroup v-if="bookmarks?.length">
          <SidebarGroupLabel>{{ t('files.bookmarks.title') }}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu :aria-label="t('files.bookmarks.title')">
              <SidebarMenuItem v-for="(b, i) in bookmarks" :key="b.path">
                <SidebarMenuButton
                  :is-active="!settingsActive && currentPath === b.path"
                  :aria-current="!settingsActive && currentPath === b.path ? 'page' : undefined"
                  :title="missingBookmarks?.has(b.path) ? t('files.bookmarks.missing', { path: b.path }) : b.path"
                  :class="missingBookmarks?.has(b.path) ? 'opacity-50' : ''"
                  @click.stop="$emit('openBookmark', b.path)"
                >
                  <BookmarkIcon class="size-4 opacity-70" aria-hidden="true" />
                  <span>{{ bookmarkLabel(b) }}</span>
                </SidebarMenuButton>
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <SidebarMenuAction show-on-hover :aria-label="t('files.bookmarks.actions', { name: bookmarkLabel(b) })" @click.stop>
                      <EllipsisIcon aria-hidden="true" />
                    </SidebarMenuAction>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem @select="$emit('renameBookmark', b)"><PencilIcon aria-hidden="true" /> {{ t('files.bookmarks.rename') }}</DropdownMenuItem>
                    <DropdownMenuItem :disabled="i === 0" @select="$emit('moveBookmark', b.path, -1)"><ArrowUpIcon aria-hidden="true" /> {{ t('files.bookmarks.moveUp') }}</DropdownMenuItem>
                    <DropdownMenuItem :disabled="i === bookmarks.length - 1" @select="$emit('moveBookmark', b.path, 1)"><ArrowDownIcon aria-hidden="true" /> {{ t('files.bookmarks.moveDown') }}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem @select="$emit('removeBookmark', b.path)"><XIcon aria-hidden="true" /> {{ t('files.bookmarks.remove') }}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
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
