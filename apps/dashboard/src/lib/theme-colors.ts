let ctx: CanvasRenderingContext2D | null = null

/**
 * Resolve a CSS custom property to an `rgb(r, g, b)` string.
 * daisyUI colors are oklch, which Chart.js cannot parse reliably, so the value
 * is painted on a 1x1 canvas and read back as sRGB. Any alpha in the custom
 * property is dropped (the pixel is read opaque): use `withAlpha` to add one.
 */
export function resolveThemeColor(name: string): string {
  const style = getComputedStyle(document.documentElement)
  const fallback = style.color
  const raw = style.getPropertyValue(name).trim()
  ctx ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!ctx || !raw) return fallback
  ctx.canvas.width = 1
  ctx.canvas.height = 1
  ctx.clearRect(0, 0, 1, 1)
  // A rejected value leaves fillStyle on the previous sentinel, so two different sentinels disagree.
  ctx.fillStyle = '#000'
  ctx.fillStyle = raw
  const withBlack = ctx.fillStyle
  ctx.fillStyle = '#fff'
  ctx.fillStyle = raw
  if (withBlack !== ctx.fillStyle) return fallback
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `rgb(${r}, ${g}, ${b})`
}

/** Same color with another alpha, for an `rgb(...)` or `rgba(...)` string. Other strings come back unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const match = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(color.trim())
  if (!match) return color
  const a = Math.min(1, Math.max(0, alpha))
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${a})`
}
