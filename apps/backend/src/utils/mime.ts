const MIME_BY_EXT: Record<string, string> = {
  // Images
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  avif: "image/avif",
  // Video
  mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime",
  mkv: "video/x-matroska", avi: "video/x-msvideo",
  // Audio
  mp3: "audio/mpeg", wav: "audio/wav", oga: "audio/ogg", ogg: "audio/ogg",
  flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac",
  // Text / code (best-effort; browsers don't need this to be exact for our use)
  txt: "text/plain", md: "text/markdown", json: "application/json",
  html: "text/html", css: "text/css", js: "text/javascript",
  pdf: "application/pdf",
}

export function guessMime(filename: string): string {
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : ""
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}

// Whitelist of MIME types it's safe to serve with Content-Disposition: inline
// (i.e. rendered directly by the browser instead of forced to save-as).
// Restricted to passive media (image/video/audio) — explicitly excludes
// image/svg+xml (can embed <script>, executes if framed/navigated-to
// directly), text/html, and XML variants, since those would otherwise
// execute as an active document on this backend's own origin (where the
// auth token lives in localStorage) if a user previews an uploaded file
// with a misleading extension. Callers must still fall back to
// attachment + application/octet-stream when this returns false.
const INLINE_UNSAFE = new Set(["image/svg+xml", "text/html", "application/xhtml+xml", "application/xml", "text/xml"])

export function isInlineSafe(mime: string): boolean {
  if (INLINE_UNSAFE.has(mime)) return false
  return mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/")
}
