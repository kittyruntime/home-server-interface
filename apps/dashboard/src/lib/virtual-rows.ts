import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

// A folder of 10,000 files froze the page: every row was rendered. Only the
// rows in view (and a margin) are rendered now, between two spacers as tall as
// the rows left out; jumping to an item (End, a typed name) scrolls to it.

export interface WindowInput { scrollTop: number; viewport: number; rowHeight: number; total: number; perRow: number; overscan: number }
export interface RowWindow { start: number; end: number; padTop: number; padBottom: number }

/** Items [start, end) to render, scrollTop being measured from the list's top. */
export function windowFor(w: WindowInput): RowWindow {
  const rows = Math.ceil(w.total / w.perRow)
  const first = Math.max(0, Math.floor(Math.max(0, w.scrollTop) / w.rowHeight) - w.overscan)
  const last = Math.min(rows, Math.ceil((Math.max(0, w.scrollTop) + w.viewport) / w.rowHeight) + w.overscan)
  const startRow = Math.min(first, last)
  return {
    start: startRow * w.perRow,
    end: Math.min(w.total, last * w.perRow),
    padTop: startRow * w.rowHeight,
    padBottom: Math.max(0, rows - last) * w.rowHeight,
  }
}

/** The scrollTop that shows item index, or null when it is already in view. */
export function scrollTopFor(a: { index: number; perRow: number; rowHeight: number; listTop: number; scrollTop: number; viewport: number }): number | null {
  const top = a.listTop + Math.floor(a.index / a.perRow) * a.rowHeight
  const bottom = top + a.rowHeight
  if (top < a.scrollTop) return top
  if (bottom > a.scrollTop + a.viewport) return bottom - a.viewport
  return null
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}

/**
 * The rows of items to render inside root. rowHeight measures a rendered row
 * (the first one, once there), perRow counts the grid's columns.
 */
export function useVirtualRows<T>(items: Ref<T[]>, root: Ref<HTMLElement | null>, opts: {
  estimate: number
  rowHeight?: () => number | null
  perRow?: () => number
  overscan?: number
}) {
  const scrollTop = ref(0)
  const viewport = ref(800)
  const listTop = ref(0)
  const rowHeight = ref(opts.estimate)
  const perRow = ref(1)
  let el: HTMLElement | null = null
  let ro: ResizeObserver | null = null

  function measure() {
    if (!el || !root.value) return
    listTop.value = root.value.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    scrollTop.value = el.scrollTop
    viewport.value = el.clientHeight
    const h = opts.rowHeight?.()
    if (h && h > 0) rowHeight.value = h
    perRow.value = Math.max(1, opts.perRow?.() ?? 1)
  }
  const onScroll = () => { if (el) scrollTop.value = el.scrollTop }

  onMounted(() => {
    el = scrollParent(root.value)
    if (!el) return
    el.addEventListener('scroll', onScroll, { passive: true })
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(el)
      if (root.value) ro.observe(root.value)
    }
    measure()
  })
  onBeforeUnmount(() => {
    el?.removeEventListener('scroll', onScroll)
    ro?.disconnect()
  })
  // The first rows rendered give the real row height.
  watch(() => items.value.length, () => requestAnimationFrame(measure))

  const range = computed(() => windowFor({
    scrollTop: scrollTop.value - listTop.value,
    viewport: viewport.value,
    rowHeight: rowHeight.value,
    total: items.value.length,
    perRow: perRow.value,
    overscan: opts.overscan ?? 8,
  }))
  const visible = computed(() => items.value.slice(range.value.start, range.value.end))

  /** Scrolls so item index is in view (it renders once there). */
  function reveal(index: number) {
    if (!el || index < 0) return
    measure()
    const top = scrollTopFor({ index, perRow: perRow.value, rowHeight: rowHeight.value, listTop: listTop.value, scrollTop: el.scrollTop, viewport: el.clientHeight })
    if (top !== null) el.scrollTop = top
  }

  return { visible, range, reveal, measure }
}
