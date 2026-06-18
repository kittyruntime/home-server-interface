export type FileKind = 'image' | 'video' | 'audio' | 'text'

// Note: .svg is deliberately NOT treated as an image here even though
// browsers can render it in <img>. The backend's inline-preview route
// refuses to serve image/svg+xml inline (it can embed <script> and execute
// if framed/navigated-to directly — see isInlineSafe() in
// apps/backend/src/utils/mime.ts), so routing .svg here would just produce
// a broken <img>. It falls through to 'text' instead, which is also a
// better fit anyway (view/edit the raw SVG/XML source).
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'ogv', 'mov', 'mkv', 'avi'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'oga', 'ogg', 'flac', 'm4a', 'aac'])

// Anything not recognized as media defaults to 'text' — the backend's
// readText procedure is the real authority on whether it's actually safe
// to render (binary sniff), this is just fast UI routing.
export function detectKind(name: string): FileKind {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return 'text'
}
