import { ref } from 'vue'

// After an App Store install, HSI shows the new app in its Apps section
// instead of opening it (#36): the shell switches to Apps, and the app list
// scrolls to the app, marks it and opens its logs once it is listed.

/** Name of the app to show; cleared by the app list once shown. */
export const pendingAppFocus = ref<string | null>(null)

export function focusNewApp(name: string): void {
  pendingAppFocus.value = name
}

/** The listed app matching the pending request, or null while it is not listed yet. */
export function appToFocus<T extends { name: string }>(pending: string | null, apps: T[]): T | null {
  if (!pending) return null
  return apps.find(a => a.name === pending) ?? null
}

// A place's properties lead to its access settings (#194): the shell opens
// Settings > Permissions, which expands that place and clears the request.

/** Id of the place whose access settings to show; cleared once shown. */
export const pendingPlaceAccess = ref<string | null>(null)

export function focusPlaceAccess(placeId: string): void {
  pendingPlaceAccess.value = placeId
}

// Another app asks for a Settings section (the Activity panel's settings link):
// the shell opens Settings on it and clears the request.

export type SettingsFocus = 'notifications'
export const pendingSettings = ref<SettingsFocus | null>(null)

export function focusSettings(section: SettingsFocus): void {
  pendingSettings.value = section
}
