import type { ComputedRef, InjectionKey } from "vue"

export type PaginationItemData = { type: "page", value: number } | { type: "ellipsis" }

export interface PaginationContext {
  page: ComputedRef<number>
  pageCount: ComputedRef<number>
  items: ComputedRef<PaginationItemData[]>
  disabled: ComputedRef<boolean>
  setPage: (page: number) => void
}

export const paginationKey: InjectionKey<PaginationContext> = Symbol("pagination")

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, idx) => idx + start)
}

/** Page numbers around the current page, with "ellipsis" where pages are skipped. */
export function getRange(currentPage: number, pageCount: number, siblingCount: number, showEdges: boolean): Array<number | "ellipsis"> {
  const first = 1
  const last = pageCount
  const leftSibling = Math.max(currentPage - siblingCount, first)
  const rightSibling = Math.min(currentPage + siblingCount, last)

  if (showEdges) {
    // Siblings on both sides, the current page, two edges and two ellipses
    const totalNumbers = Math.min(2 * siblingCount + 5, pageCount)
    const itemCount = totalNumbers - 2
    const leftEllipsis = leftSibling > first + 2 && Math.abs(last - itemCount - first + 1) > 2 && Math.abs(leftSibling - first) > 2
    const rightEllipsis = rightSibling < last - 2 && Math.abs(last - itemCount) > 2 && Math.abs(last - rightSibling) > 2

    if (!leftEllipsis && rightEllipsis)
      return [...range(1, itemCount), "ellipsis", last]
    if (leftEllipsis && !rightEllipsis)
      return [first, "ellipsis", ...range(last - itemCount + 1, last)]
    if (leftEllipsis && rightEllipsis)
      return [first, "ellipsis", ...range(leftSibling, rightSibling), "ellipsis", last]
    return range(first, last)
  }

  const itemCount = siblingCount * 2 + 1
  if (pageCount < itemCount)
    return range(1, last)
  if (currentPage <= siblingCount + 1)
    return range(first, itemCount)
  if (pageCount - currentPage <= siblingCount)
    return range(pageCount - itemCount + 1, last)
  return range(leftSibling, rightSibling)
}
