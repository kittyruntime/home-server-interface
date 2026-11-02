import { createSharedComposable, useMediaQuery } from '@vueuse/core'

// Below Tailwind's sm breakpoint: lists render as cards there, as a table
// above. Rendering only one of the two (v-if) instead of hiding one with CSS
// keeps a single copy of each row in the DOM.
export const useNarrow = createSharedComposable(() => useMediaQuery('(max-width: 639px)'))
