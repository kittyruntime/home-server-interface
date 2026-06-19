// Cheap magic-byte sniff for the three image types the wallpaper upload
// accepts — mirrors utils/text-sniff.ts's "don't trust the client's
// Content-Type, look at the actual bytes" approach.
export function detectImageType(buf: Buffer): "png" | "jpeg" | "webp" | null {
  if (buf.length < 12) return null

  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png"
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "webp"

  return null
}
