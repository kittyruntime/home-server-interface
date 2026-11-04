// Copies text to the clipboard (#197). navigator.clipboard only exists in a
// secure context (HTTPS or localhost); a NAS opened over plain HTTP on the LAN
// falls back to a hidden textarea and the legacy copy command.

export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && globalThis.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* permission refused: try the fallback */ }
  }
  return legacyCopy(text)
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  // Keep focus where it was (a dialog's focus trap, the list). Inside a modal
  // <dialog> the rest of the page is inert, so the textarea goes in the dialog.
  const previous = document.activeElement as HTMLElement | null
  const host = previous?.closest('dialog[open]') ?? document.body
  host.appendChild(area)
  area.select()
  let ok: boolean
  try { ok = document.execCommand('copy') } catch { ok = false }
  area.remove()
  previous?.focus?.()
  return ok
}
