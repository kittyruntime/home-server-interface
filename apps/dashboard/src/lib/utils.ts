import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/* tailwind-merge must know the custom font-size steps from style.css
   (text-2xs, text-control): unknown, it reads them as text colors and drops
   one of `text-2xs text-muted-foreground` as a conflict. */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['2xs', 'control'],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
