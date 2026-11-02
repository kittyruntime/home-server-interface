let ctx: CanvasRenderingContext2D | null = null

/**
 * Resolve a CSS custom property to an `rgb(r, g, b)` string.
 * daisyUI colors are oklch, which Chart.js cannot parse reliably, so the value
 * is painted on a 1x1 canvas and read back as sRGB.
 */
export function resolveThemeColor(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  ctx ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!ctx) return raw
  ctx.canvas.width = 1
  ctx.canvas.height = 1
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = '#000'
  ctx.fillStyle = raw
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `rgb(${r}, ${g}, ${b})`
}
