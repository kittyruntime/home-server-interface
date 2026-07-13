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
export const ICONS: Record<string, string> = {
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
}
