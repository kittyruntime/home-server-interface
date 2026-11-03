/* Look of the entries of a menu, on top of daisyUI's `menu`. */
export const menuItemClass = [
  'relative cursor-default outline-hidden select-none',
  'focus:bg-base-content/10 focus:text-base-content',
  'data-[inset]:pl-8',
  'data-[variant=destructive]:text-error data-[variant=destructive]:hover:bg-error/10 data-[variant=destructive]:focus:bg-error/10 data-[variant=destructive]:focus:text-error',
  '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4 [&_svg:not([class*=\'text-\'])]:text-base-content/60',
  'data-[variant=destructive]:[&_svg]:text-current!',
].join(' ')

export const menuContentClass = [
  'menu bg-base-100 text-base-content z-50 min-w-32 max-w-[calc(100vw-1rem)] flex-nowrap gap-0.5 overflow-x-hidden overflow-y-auto',
  'max-h-[calc(100dvh-1rem)] rounded-box border border-base-300 p-1 shadow-md outline-hidden',
  'ui-float',
].join(' ')

export function menuSlot(kind: 'dropdown' | 'context', name: string): string {
  return `${kind === 'context' ? 'context-menu' : 'dropdown-menu'}-${name}`
}
