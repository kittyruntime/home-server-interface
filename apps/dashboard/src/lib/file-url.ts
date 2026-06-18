const BASE_URL = import.meta.env.VITE_API_URL ? import.meta.env.VITE_API_URL.replace(/\/trpc$/, '') : ''

// Inline preview URL (Content-Disposition: inline, real Content-Type, Range
// support) for <img>/<video>/<audio> tags — same query-token auth pattern as
// the existing download link.
export function previewUrl(path: string, token: string): string {
  return `${BASE_URL}/files/download?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}&inline=1`
}

export function downloadUrl(path: string, token: string): string {
  return `${BASE_URL}/files/download?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`
}
