<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { ChevronsLeftRightIcon, ChevronsUpDownIcon, LayoutGridIcon, PlusIcon, XIcon } from '@lucide/vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { computed, reactive } from 'vue'
import WidgetBody from './WidgetBody.vue'
import GettingStartedCard from './GettingStartedCard.vue'
import HttpsBanner from './HttpsBanner.vue'
import { useDashboardWidgets, catalogFor } from '../../lib/dashboard-widgets'
import { useAuth } from '../../lib/auth'

const { t } = useI18n()

const {
  widgets, metrics,
  cpuHist, rxHist, txHist,
  uptimeStr, ctrRunning, ctrStopped, ctrError,
  disks, sysinfo, smart, smartDevices,
  toggleCols, removeWidget, addWidget,
} = useDashboardWidgets()

const emit = defineEmits<{ navigate: [target: 'places' | 'store' | 'backups' | 'secure'] }>()

const { isAdmin, hasCapability } = useAuth()
const catalog = computed(() => catalogFor(isAdmin.value, cap => hasCapability(cap).value))

// What every widget body reads (reactive() unwraps the refs for v-bind).
const body = reactive({ metrics, cpuHist, rxHist, txHist, ctrRunning, ctrStopped, ctrError, disks, sysinfo, smart, smartDevices })

</script>

<template>
  <div class="flex flex-col h-full">

    <!-- Toolbar -->
    <div class="flex items-center justify-between px-4 sm:px-6 py-3.5 sm:py-4 border-b border-base-300 flex-shrink-0">
      <div class="flex items-center gap-3">
        <h3 class="text-sm font-semibold text-base-content">{{ t('ui.home.DashboardPanel.overview') }}</h3>
        <span v-if="metrics" class="text-xs tabular-nums text-base-content/70">{{ uptimeStr }}</span>
      </div>

      <!-- Add widget dropdown -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="outline" size="sm">
            <PlusIcon aria-hidden="true" />
            {{ t('ui.home.DashboardPanel.add') }}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="min-w-[140px]">
          <DropdownMenuItem v-for="cat in catalog" :key="cat.type" @select="addWidget(cat.type)">
            {{ cat.label }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <HttpsBanner v-if="isAdmin" @navigate="emit('navigate', $event)" />
    <GettingStartedCard v-if="isAdmin" @navigate="emit('navigate', $event)" />

    <!-- Widget grid -->
    <div class="flex-1 overflow-y-auto p-4 sm:p-6">
      <div v-if="widgets.length === 0" class="flex flex-col items-center justify-center h-full gap-3 text-base-content/70">
        <LayoutGridIcon class="w-10 h-10 opacity-20" aria-hidden="true" />
        <p class="text-sm">{{ t('ui.home.DashboardPanel.noWidgetsClick') }} <strong class="text-base-content/80">{{ t('ui.home.DashboardPanel.add') }}</strong> {{ t('ui.home.DashboardPanel.toGetStarted') }}</p>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div
          v-for="w in widgets" :key="w.id"
          :class="['relative group/card bg-base-200 border border-base-300 rounded-xl p-4 sm:p-5 min-h-[130px] flex flex-col', w.cols === 2 ? 'col-span-1 sm:col-span-2' : 'col-span-1']"
        >
          <!-- Widget controls -->
          <div class="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover/card:opacity-100 focus-within:opacity-100 transition-opacity">
            <Button variant="ghost" size="icon-xs"
              @click="toggleCols(w)"
              :tooltip="w.cols === 1 ? 'Expand' : 'Shrink'"
              :aria-label="w.cols === 1 ? 'Expand widget' : 'Shrink widget'"
              class="text-base-content/70"
            >
              <component :is="w.cols === 1 ? ChevronsLeftRightIcon : ChevronsUpDownIcon" class="size-3.5" aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="icon-xs"
              @click="removeWidget(w.id)"
              :tooltip="t('ui.home.DashboardPanel.remove')" :aria-label="t('ui.home.DashboardPanel.remove')"
              class="text-base-content/70 hover:text-primary hover:bg-primary/10"
            >
              <XIcon class="w-3 h-3" aria-hidden="true" />
            </Button>
          </div>

          <WidgetBody :w="w" v-bind="body" />

        </div>
      </div>
    </div>
  </div>
</template>

