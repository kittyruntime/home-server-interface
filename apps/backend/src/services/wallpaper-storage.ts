import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, writeFile, unlink } from "node:fs/promises"

// Plain local app-data storage — these are small UI-setting images, not
// NAS-browsable user files, so they deliberately skip the
// NATS/root-worker pipeline used for everything under fs.ts. Same
// resolution pattern as DASHBOARD_DIR in app.ts: env override for
// production layouts, otherwise relative to this module's own directory.
const WALLPAPER_DIR = process.env.WALLPAPER_DIR
  ? path.resolve(process.env.WALLPAPER_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/wallpapers")

export function wallpaperPath(userId: string, ext: string): string {
  return path.join(WALLPAPER_DIR, `${userId}.${ext}`)
}

export async function writeWallpaperFile(userId: string, ext: string, data: Buffer): Promise<void> {
  await mkdir(WALLPAPER_DIR, { recursive: true })
  await writeFile(wallpaperPath(userId, ext), data)
}

export async function deleteWallpaperFile(userId: string, ext: string): Promise<void> {
  try {
    await unlink(wallpaperPath(userId, ext))
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e
  }
}
