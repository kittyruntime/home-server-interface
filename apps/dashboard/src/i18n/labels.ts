import { watchEffect } from 'vue'
import { i18n } from '.'
import { APP_LABEL, type AppId } from '../lib/desktop'
import { NAV_TEXT, SECTION_LABELS, type StorageSection } from '../lib/storage-nav'

// Names kept in plain modules (shared with tests run outside the browser),
// put in the interface language whenever it changes.
const APPS: Record<AppId, string> = {
  files: 'files', apps: 'apps', settings: 'settings', storage: 'storage',
  store: 'store', monitor: 'monitor', sharing: 'sharing', 'file-preview': 'filePreview',
}

watchEffect(() => {
  const t = i18n.global.t
  for (const [id, key] of Object.entries(APPS)) APP_LABEL[id as AppId] = t(`apps.${key}`)
  for (const s of Object.keys(SECTION_LABELS) as StorageSection[]) SECTION_LABELS[s] = t(`storage.nav.${s}`)
  NAV_TEXT.createVolume = t('storage.createVolume')
})
