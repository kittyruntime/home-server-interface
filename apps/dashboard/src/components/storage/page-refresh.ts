import { usePoll } from '../../lib/poll'

// Keep an object page current while it is open: reload when the window gets
// the focus back, when the tab becomes visible, and every minute.
export function usePageRefresh(reload: () => unknown, everyMs = 60_000) {
  usePoll(reload, everyMs, { immediate: false, onFocus: true })
}
