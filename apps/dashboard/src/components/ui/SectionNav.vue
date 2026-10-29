<script setup lang="ts" generic="T extends string">
import type { SectionNavItem } from './section-nav'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar'

const { t } = useI18n()

// Section navigation of a panel (Settings, Storage, Monitor, Sharing): the
// shadcn-vue sidebar on wide layouts, a select on narrow ones. `container`
// switches on the panel's width (a desktop window) instead of the screen's.
const props = defineProps<{
  items: SectionNavItem<T>[]
  container?: boolean
}>()
const active = defineModel<T>({ required: true })

const groups = computed(() => {
  const out: { label?: string; items: SectionNavItem<T>[] }[] = []
  for (const item of props.items) {
    const last = out[out.length - 1]
    if (last && last.label === item.group) last.items.push(item)
    else out.push({ label: item.group, items: [item] })
  }
  return out
})
</script>

<template>
  <div :class="['shrink-0 border-b bg-sidebar px-4 py-2.5', container ? '@2xl:hidden' : 'sm:hidden']">
    <Select v-model="active">
      <SelectTrigger class="w-full" :aria-label="t('common.section')">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="item in items" :key="item.id" :value="item.id">{{ item.label }}</SelectItem>
      </SelectContent>
    </Select>
  </div>

  <SidebarProvider
    :class="['min-h-0 w-auto shrink-0', container ? 'hidden @2xl:flex' : 'hidden sm:flex']"
    :style="{ '--sidebar-width': '14rem' }"
  >
    <Sidebar collapsible="none" class="h-full border-r">
      <SidebarContent class="py-3">
        <SidebarGroup v-for="(group, i) in groups" :key="group.label ?? i" class="py-1">
          <SidebarGroupLabel v-if="group.label">{{ group.label }}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu :aria-label="t('common.sections')">
              <SidebarMenuItem v-for="item in group.items" :key="item.id">
                <SidebarMenuButton
                  :is-active="active === item.id"
                  :aria-current="active === item.id ? 'page' : undefined"
                  @click="active = item.id"
                >
                  <component :is="item.icon" aria-hidden="true" />
                  <span>{{ item.label }}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  </SidebarProvider>
</template>
