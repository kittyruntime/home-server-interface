// Raw SVG markup for each catalog app, keyed by manifest id.
//
// Kept as plain string constants (rather than `?raw`-imported from the
// sibling `../icons/*.svg` files) so this module is a completely ordinary
// ES module: no bundler-specific import suffix (`?raw` is a Vite-only
// feature and isn't understood by the backend's plain tsc/Node toolchain),
// and no Node built-ins (`fs`/`createRequire`) that Rollup/Vite cannot
// resolve when this package is bundled for the browser.
//
// The `../icons/*.svg` files remain the canonical, human-editable source
// for each icon (for design review, static serving, etc.) — keep the
// strings below in sync with them when an icon changes.
export const ICONS: Record<
  | 'jellyfin'
  | 'vaultwarden'
  | 'navidrome'
  | 'adguard'
  | 'syncthing'
  | 'qbittorrent'
  | 'uptime-kuma'
  | 'filebrowser'
  | 'homarr'
  | 'it-tools',
  string
> = {
  jellyfin: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2.5" y="4.5" width="19" height="13" rx="2"/>
  <path d="M9.5 8.25v5.5l5-2.75z" fill="currentColor" stroke="none"/>
  <path d="M8 20.5h8"/>
  <path d="M12 17.5v3"/>
</svg>
`,
  vaultwarden: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 2.5 4.5 5.5v5.25c0 5.06 3.2 8.72 7.5 10.75 4.3-2.03 7.5-5.69 7.5-10.75V5.5z"/>
  <rect x="9.25" y="12" width="5.5" height="4.5" rx="1"/>
  <path d="M10.25 12v-1.75a1.75 1.75 0 0 1 3.5 0V12"/>
</svg>
`,
  navidrome: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="7" cy="17.5" r="2.5"/>
  <circle cx="16" cy="15.5" r="2.5"/>
  <path d="M9.5 17.5V6.5l9-2v11"/>
</svg>
`,
  adguard: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 3 5 5.75v4.75c0 4.85 2.95 8.35 7 9.75 4.05-1.4 7-4.9 7-9.75V5.75z"/>
  <path d="M8.75 12.25l2.25 2.25 4.25-4.75"/>
</svg>
`,
  syncthing: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4.5 12a7.5 7.5 0 0 1 12.5-5.6"/>
  <path d="M19.5 12a7.5 7.5 0 0 1-12.5 5.6"/>
  <path d="M17 4.5v3h-3"/>
  <path d="M7 19.5v-3h3"/>
</svg>
`,
  qbittorrent: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 3.5v11"/>
  <path d="M8 11l4 4 4-4"/>
  <path d="M4.5 16.5v2A2 2 0 0 0 6.5 20.5h11a2 2 0 0 0 2-2v-2"/>
</svg>
`,
  'uptime-kuma': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2.5 12h4l2-6 3 12 2.5-9 1.5 3h6"/>
</svg>
`,
  filebrowser: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>
</svg>
`,
  homarr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3.5" y="3.5" width="7" height="7" rx="1.25"/>
  <rect x="13.5" y="3.5" width="7" height="7" rx="1.25"/>
  <rect x="3.5" y="13.5" width="7" height="7" rx="1.25"/>
  <rect x="13.5" y="13.5" width="7" height="7" rx="1.25"/>
</svg>
`,
  'it-tools': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M14.5 3.5a4 4 0 0 0-5 4.9L4 14l2 2 5.6-5.5a4 4 0 0 0 4.9-5z"/>
  <path d="M5 19l-1 1"/>
</svg>
`,
}
