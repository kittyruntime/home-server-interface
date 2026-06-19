import { trpc } from './trpc'

const BASE_URL = import.meta.env.VITE_API_URL ? import.meta.env.VITE_API_URL.replace(/\/trpc$/, '') : ''

// Mints a short-lived, single-path-scoped file token (fs.createFileToken)
// and builds the /files/download URL around it — never the long-lived
// session JWT, which would otherwise sit in URLs, browser history, and
// server access logs for as long as the session lives.
async function fileUrl(path: string, inline: boolean): Promise<string> {
  const { token } = await trpc.fs.createFileToken.query({ path })
  const suffix = inline ? '&inline=1' : ''
  return `${BASE_URL}/files/download?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}${suffix}`
}

// Inline preview URL (Content-Disposition: inline, real Content-Type, Range
// support) for <img>/<video>/<audio> tags.
export function previewUrl(path: string): Promise<string> {
  return fileUrl(path, true)
}

export function downloadUrl(path: string): Promise<string> {
  return fileUrl(path, false)
}
