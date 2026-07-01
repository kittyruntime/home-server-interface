import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, writeFile, unlink } from "node:fs/promises"

// Plain local app-data storage — these are small UI-setting images, not
// NAS-browsable user files, so they deliberately skip the
// NATS/root-worker pipeline used for everything under fs.ts.
//
// Production runs the backend as a single esbuild bundle (server.js) sitting
// directly at INSTALL_DIR's root (see scripts/install.sh), so import.meta.url
// always resolves to that one flat location regardless of which source file
// the code originally lived in — a "../../data/wallpapers" escape (correct
// for the unbundled dev tree, apps/backend/src/services/) walks two levels
// above INSTALL_DIR in production and lands outside the systemd sandbox's
// ReadWritePaths, e.g. resolving to /data instead of INSTALL_DIR/data.
// INSTALL_DIR is set by systemd (same variable update.ts's installDir() uses)
// so prefer it explicitly instead of guessing from the module's own path.
const WALLPAPER_DIR = process.env.WALLPAPER_DIR
  ? path.resolve(process.env.WALLPAPER_DIR)
  : process.env.INSTALL_DIR
  ? path.resolve(process.env.INSTALL_DIR, "data/wallpapers")
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
