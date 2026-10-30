import { watchEffect } from 'vue'
import { i18n } from '.'
import { APP_LABEL, type AppId } from '../lib/desktop'
import { NAV_TEXT, SECTION_LABELS, type StorageSection } from '../lib/storage-nav'
import { setTranslator } from '../lib/tr'
import { LOADING } from '../lib/loading'

// Names kept in plain modules (shared with tests run outside the browser),
// put in the interface language whenever it changes.
const APPS: Record<AppId, string> = {
  files: 'files', apps: 'apps', settings: 'settings', storage: 'storage',
  store: 'store', monitor: 'monitor', sharing: 'sharing', assistant: 'assistant', 'file-preview': 'filePreview',
}

watchEffect(() => {
  const t = i18n.global.t
  for (const [id, key] of Object.entries(APPS)) APP_LABEL[id as AppId] = t(`apps.${key}`)
  for (const s of Object.keys(SECTION_LABELS) as StorageSection[]) SECTION_LABELS[s] = t(`storage.nav.${s}`)
  NAV_TEXT.createVolume = t('storage.createVolume')
  for (const k of Object.keys(LOADING) as (keyof typeof LOADING)[]) LOADING[k] = t(`lib.loading.${k}`)
})

// Plain modules ask through lib/tr: the message when this language has it,
// else their English text.
setTranslator((key, english, params) => i18n.global.te(key) ? i18n.global.t(key, params ?? {}) : english)
