import { onMounted, onUnmounted } from 'vue'

// Keep an object page current while it is open: reload when the window gets
// the focus back, when the tab becomes visible, and every minute.
export function usePageRefresh(reload: () => unknown, everyMs = 60_000) {
  const onFocus = () => { if (!document.hidden) void reload() }
  let timer: ReturnType<typeof setInterval> | null = null
  onMounted(() => {
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    timer = setInterval(onFocus, everyMs)
  })
  onUnmounted(() => {
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onFocus)
    if (timer) clearInterval(timer)
  })
}
