import { zAppManifest, type AppManifest } from "./manifest"
import { ICONS } from "./icons"
import jellyfin from "../apps/jellyfin.json" with { type: "json" }
import vaultwarden from "../apps/vaultwarden.json" with { type: "json" }
import navidrome from "../apps/navidrome.json" with { type: "json" }
import adguard from "../apps/adguard.json" with { type: "json" }
import syncthing from "../apps/syncthing.json" with { type: "json" }
import qbittorrent from "../apps/qbittorrent.json" with { type: "json" }
import uptimeKuma from "../apps/uptime-kuma.json" with { type: "json" }
import filebrowser from "../apps/filebrowser.json" with { type: "json" }
import homarr from "../apps/homarr.json" with { type: "json" }
import itTools from "../apps/it-tools.json" with { type: "json" }

// NOTE on the loader strategy: the backend consumes this package through a
// plain TypeScript/Node toolchain (tsc + `node`), while the dashboard
// consumes it through Vite. `?raw` icon imports and bundler-only JSON
// interop are Vite features that don't resolve under plain tsc/Node, and
// conversely `node:fs`/`createRequire` (the "read the file at runtime"
// fallback) cannot be bundled for the browser by Vite/Rollup (it hard-fails
// the production build, since those built-ins get externalized to an empty
// shim). The JSON import below uses the standard `with { type: "json" }`
// import attribute, which both Node's native ESM loader and Vite/Rollup's
// built-in JSON handling understand. Icons are plain string constants from
// "./icons" (see that file for why), so no bundler- or runtime-specific
// import form is needed for them either.
const RAW: { manifest: unknown; icon: string }[] = [
  { manifest: jellyfin, icon: ICONS.jellyfin },
  { manifest: vaultwarden, icon: ICONS.vaultwarden },
  { manifest: navidrome, icon: ICONS.navidrome },
  { manifest: adguard, icon: ICONS.adguard },
  { manifest: syncthing, icon: ICONS.syncthing },
  { manifest: qbittorrent, icon: ICONS.qbittorrent },
  { manifest: uptimeKuma, icon: ICONS["uptime-kuma"] },
  { manifest: filebrowser, icon: ICONS.filebrowser },
  { manifest: homarr, icon: ICONS.homarr },
  { manifest: itTools, icon: ICONS["it-tools"] },
]

export const CATALOG: AppManifest[] = RAW.map(({ manifest, icon }) => ({
  ...zAppManifest.parse(manifest), // throws at load if a manifest is malformed
  icon,
}))

export { zAppManifest, type AppManifest } from "./manifest"
