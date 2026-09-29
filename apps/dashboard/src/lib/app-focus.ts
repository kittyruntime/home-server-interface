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
