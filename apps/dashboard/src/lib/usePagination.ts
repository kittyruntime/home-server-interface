import { ref, computed, type Ref } from 'vue'

export function usePagination<T>(items: Ref<T[]>, pageSize = 10) {
  const page = ref(1)
  const pageCount = computed(() => Math.max(1, Math.ceil(items.value.length / pageSize)))
  const paged = computed(() => items.value.slice((page.value - 1) * pageSize, page.value * pageSize))

  function goPage(n: number) {
    page.value = Math.max(1, Math.min(n, pageCount.value))
  }

  /** Pull the current page back in range after the underlying list shrinks. */
  function clampPage() {
    if (page.value > pageCount.value) page.value = pageCount.value
  }

  return { page, pageCount, paged, pageSize, goPage, clampPage }
}
