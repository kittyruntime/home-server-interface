import { ref } from 'vue'

// Whether the file manager asks before deleting. Kept in localStorage for an
// instant read and synced with the account by ./preferences.ts, so turning it
// off (or back on) follows the user to every browser.
const STORAGE_KEY = 'confirmFileDelete'

function load(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== '0'
}

const confirmFileDelete = ref<boolean>(load())

export function useDeleteConfirm() {
  function setConfirmFileDelete(v: boolean) {
    confirmFileDelete.value = v
    localStorage.setItem(STORAGE_KEY, v ? '1' : '0')
  }
  return { confirmFileDelete, setConfirmFileDelete }
}
