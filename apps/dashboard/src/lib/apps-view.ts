import { ref } from 'vue'

// The Apps app holds both the apps this server runs and the App Store. The
// view stays as it was left while the session lasts; other parts of the
// dashboard ask for one (the getting-started card for the store, a finished
// install for the installed apps).

export type AppsView = 'installed' | 'store'

export const appsView = ref<AppsView>('installed')

export function showAppsView(view: AppsView): void {
  appsView.value = view
}
