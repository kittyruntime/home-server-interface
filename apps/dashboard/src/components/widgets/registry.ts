import { defineAsyncComponent, type Component } from 'vue'
import {
  ActivityIcon, AppWindowIcon, ArchiveRestoreIcon, BatteryChargingIcon, BellIcon, CpuIcon, FolderIcon,
  HardDriveIcon, HistoryIcon, LinkIcon, MemoryStickIcon, NetworkIcon, NotebookPenIcon, RefreshCwIcon,
  ScrollTextIcon, Share2Icon, SparklesIcon, ThermometerIcon, Trash2Icon, TrendingUpIcon, UsersIcon,
  DatabaseIcon,
} from '@lucide/vue'
import type { WidgetSize } from '../../lib/dashboard-boards'

// Every widget the dashboard offers. Titles and descriptions are in
// widgets.types.<type>; a type a board names but this release does not know
// (a board written by a newer release) is skipped, not dropped.

export type WidgetAccess = 'all' | 'admin' | 'storage'
export type WidgetGroup = 'system' | 'storage' | 'apps' | 'people' | 'tools'
/** Where a click on the title leads: an app, and a Settings section. */
export type OpenTarget = { app: string; section?: string }

export type SettingField =
  | { key: string; kind: 'select'; options: string[] }
  | { key: string; kind: 'text' | 'textarea' | 'links' }

export interface WidgetDef {
  type: string
  icon: Component
  group: WidgetGroup
  access: WidgetAccess
  sizes: WidgetSize[]
  size: WidgetSize
  open?: OpenTarget
  settings?: SettingField[]
  component: Component
}

const lazy = (load: () => Promise<{ default: Component }>) => defineAsyncComponent({ loader: load, delay: 0 })

export const WIDGETS: WidgetDef[] = [
  // System
  { type: 'cpu', icon: CpuIcon, group: 'system', access: 'all', sizes: ['s', 'm'], size: 's', open: { app: 'monitor' }, component: lazy(() => import('./types/CpuWidget.vue')) },
  { type: 'memory', icon: MemoryStickIcon, group: 'system', access: 'all', sizes: ['s', 'm'], size: 's', open: { app: 'monitor' }, component: lazy(() => import('./types/MemoryWidget.vue')) },
  { type: 'network', icon: NetworkIcon, group: 'system', access: 'all', sizes: ['s', 'm'], size: 's', open: { app: 'monitor' }, component: lazy(() => import('./types/NetworkWidget.vue')) },
  {
    type: 'history', icon: HistoryIcon, group: 'system', access: 'admin', sizes: ['m', 'l'], size: 'm', open: { app: 'monitor' },
    settings: [{ key: 'metric', kind: 'select', options: ['cpu', 'memory', 'network'] }, { key: 'period', kind: 'select', options: ['24h', '7d'] }],
    component: lazy(() => import('./types/HistoryWidget.vue')),
  },
  { type: 'sensors', icon: ThermometerIcon, group: 'system', access: 'all', sizes: ['s', 'm', 'l'], size: 'm', component: lazy(() => import('./types/SensorsWidget.vue')) },
  { type: 'ups', icon: BatteryChargingIcon, group: 'system', access: 'all', sizes: ['s', 'm'], size: 's', component: lazy(() => import('./types/UpsWidget.vue')) },
  {
    type: 'consumers', icon: UsersIcon, group: 'system', access: 'admin', sizes: ['m', 'l'], size: 'm', open: { app: 'monitor' },
    settings: [{ key: 'metric', kind: 'select', options: ['cpu', 'rss', 'disk'] }],
    component: lazy(() => import('./types/ConsumersWidget.vue')),
  },
  { type: 'digest', icon: SparklesIcon, group: 'system', access: 'admin', sizes: ['m', 'l'], size: 'm', open: { app: 'assistant' }, component: lazy(() => import('./types/DigestWidget.vue')) },

  // Storage
  { type: 'alerts', icon: BellIcon, group: 'storage', access: 'storage', sizes: ['s', 'm', 'l'], size: 'm', open: { app: 'monitor' }, component: lazy(() => import('./types/AlertsWidget.vue')) },
  { type: 'volumes', icon: DatabaseIcon, group: 'storage', access: 'storage', sizes: ['m', 'l'], size: 'm', open: { app: 'storage' }, component: lazy(() => import('./types/VolumesWidget.vue')) },
  { type: 'disks', icon: HardDriveIcon, group: 'storage', access: 'storage', sizes: ['s', 'm', 'l'], size: 'm', open: { app: 'storage' }, component: lazy(() => import('./types/DisksWidget.vue')) },
  { type: 'forecast', icon: TrendingUpIcon, group: 'storage', access: 'storage', sizes: ['m', 'l'], size: 'm', open: { app: 'storage' }, component: lazy(() => import('./types/ForecastWidget.vue')) },
  { type: 'backups', icon: ArchiveRestoreIcon, group: 'storage', access: 'admin', sizes: ['m', 'l'], size: 'm', open: { app: 'settings', section: 'data-backups' }, component: lazy(() => import('./types/BackupsWidget.vue')) },
  { type: 'trash', icon: Trash2Icon, group: 'storage', access: 'all', sizes: ['s', 'm'], size: 's', open: { app: 'files' }, component: lazy(() => import('./types/TrashWidget.vue')) },

  // Apps and updates
  { type: 'apps', icon: AppWindowIcon, group: 'apps', access: 'admin', sizes: ['s', 'm', 'l'], size: 'm', open: { app: 'apps' }, component: lazy(() => import('./types/AppsWidget.vue')) },
  { type: 'updates', icon: RefreshCwIcon, group: 'apps', access: 'admin', sizes: ['s', 'm'], size: 's', open: { app: 'settings', section: 'updates' }, component: lazy(() => import('./types/UpdatesWidget.vue')) },
  { type: 'activity', icon: ActivityIcon, group: 'apps', access: 'all', sizes: ['s', 'm', 'l'], size: 's', open: { app: 'activity' }, component: lazy(() => import('./types/ActivityWidget.vue')) },

  // People and sharing
  { type: 'shares', icon: Share2Icon, group: 'people', access: 'all', sizes: ['s', 'm', 'l'], size: 'm', open: { app: 'sharing' }, component: lazy(() => import('./types/SharesWidget.vue')) },
  { type: 'journal', icon: ScrollTextIcon, group: 'people', access: 'admin', sizes: ['m', 'l'], size: 'm', open: { app: 'monitor' }, component: lazy(() => import('./types/JournalWidget.vue')) },
  { type: 'places', icon: FolderIcon, group: 'people', access: 'all', sizes: ['s', 'm', 'l'], size: 'm', open: { app: 'files' }, component: lazy(() => import('./types/PlacesWidget.vue')) },

  // Tools
  { type: 'note', icon: NotebookPenIcon, group: 'tools', access: 'all', sizes: ['s', 'm', 'l'], size: 'm', settings: [{ key: 'text', kind: 'textarea' }], component: lazy(() => import('./types/NoteWidget.vue')) },
  { type: 'links', icon: LinkIcon, group: 'tools', access: 'all', sizes: ['s', 'm', 'l'], size: 'm', settings: [{ key: 'links', kind: 'links' }], component: lazy(() => import('./types/LinksWidget.vue')) },
]

export const GROUPS: WidgetGroup[] = ['system', 'storage', 'apps', 'people', 'tools']

const BY_TYPE = new Map(WIDGETS.map(w => [w.type, w]))
export const widgetDef = (type: string): WidgetDef | undefined => BY_TYPE.get(type)

/** Whether this viewer may use a widget type (it reads admin or storage data). */
export function canUse(def: WidgetDef | undefined, viewer: { isAdmin: boolean; storage: boolean }): boolean {
  if (!def) return false
  if (def.access === 'all') return true
  if (def.access === 'admin') return viewer.isAdmin
  return viewer.isAdmin || viewer.storage
}

/** i18n key of a widget type: `disk-health` reads widgets.types.diskHealth. */
export const typeKey = (type: string) => type.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
