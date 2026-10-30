import { createApp } from 'vue'
// Self-hosted fonts, only the weights in use.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/space-mono/400.css'
import '@fontsource/space-mono/700.css'
import 'vue-sonner/style.css'
import './style.css'
import App from './App.vue'
import router from './router'
import { i18n, loadLocale, type Locale } from './i18n'
import './i18n/labels'

// Mount once the starting language is loaded, so it never flashes English.
// A failed load still mounts, in English.
void loadLocale(i18n.global.locale.value as Locale).catch(() => {}).finally(() => {
  createApp(App).use(router).use(i18n).mount('#app')
})
