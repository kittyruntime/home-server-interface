import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

// A folder of 10,000 files froze the page: every row was rendered at once,
// and every selection change re-rendered them all. The list shows a first
// step of items, then one more each time the end comes near; an item selected
// further down (End, Ctrl+A, a search) is shown with a step after it.

export const LIST_STEP = 300

export function growLimit(limit: number, total: number): number {
  return Math.min(total, limit + LIST_STEP)
}

export function revealLimit(limit: number, index: number): number {
  return index < limit ? limit : index + LIST_STEP
}

/**
 * The items to render, and a sentinel element to put after them: when it comes
 * within a screen of the scroll area's end, the next step is rendered.
 */
export function useProgressiveList<T extends { path: string }>(items: Ref<T[]>, selected: Ref<Set<string>>) {
  const limit = ref(LIST_STEP)
  const visible = computed(() => items.value.length > limit.value ? items.value.slice(0, limit.value) : items.value)
  const sentinel = ref<HTMLElement | null>(null)
  let observer: IntersectionObserver | null = null

  onMounted(() => {
    if (typeof IntersectionObserver === 'undefined') return
    observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) limit.value = growLimit(limit.value, items.value.length)
    }, { rootMargin: '0px 0px 800px 0px' })
    watch(sentinel, (el, old) => {
      if (old) observer?.unobserve(old)
      if (el) observer?.observe(el)
    }, { immediate: true })
  })
  onBeforeUnmount(() => observer?.disconnect())

  // Show what is selected beyond the rendered part (End, Ctrl+A, type-ahead).
  const indexOf = computed(() => new Map(items.value.map((e, i) => [e.path, i])))
  watch(selected, sel => {
    let furthest = -1
    for (const p of sel) furthest = Math.max(furthest, indexOf.value.get(p) ?? -1)
    if (furthest >= limit.value) limit.value = revealLimit(limit.value, furthest)
  })

  const hasMore = computed(() => items.value.length > limit.value)
  return { visible, sentinel, hasMore }
}
