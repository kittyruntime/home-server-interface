import type { InjectionKey, Ref } from 'vue'

/* Provided by DesktopWindow with its content element: modals opened from an
   app running in a window render inside that window's frame instead of
   covering the whole screen. Absent (classic mode, mobile, desktop-level
   dialogs), Modal falls back to a fullscreen teleport to <body>. */
export const modalHostKey: InjectionKey<Ref<HTMLElement | null>> = Symbol('modal-host')
