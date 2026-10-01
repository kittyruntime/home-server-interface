import { ref } from 'vue'
import type { LocationRequest, StorageLocation } from './storage-nav'

// Open the Storage app on a location from anywhere (alerts, other apps): the
// shell opens or focuses Storage, and the Storage panel navigates to it.
export const pendingStorageLocation = ref<LocationRequest | null>(null)

export function openStorage(loc: StorageLocation): void {
  pendingStorageLocation.value = { loc: { ...loc }, at: Date.now() }
}
