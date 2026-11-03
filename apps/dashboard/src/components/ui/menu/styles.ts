/* Look of the entries of a menu, on top of daisyUI's `menu`. */
export const menuItemClass = [
  'relative cursor-default outline-hidden select-none',
  'focus:bg-base-content/10 focus:text-base-content',
  'data-[inset]:pl-8',
  'data-[variant=destructive]:text-error data-[variant=destructive]:hover:bg-error/10 data-[variant=destructive]:focus:bg-error/10 data-[variant=destructive]:focus:text-error',
  '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4 [&_svg:not([class*=\'text-\'])]:text-base-content/60',
  'data-[variant=destructive]:*:[svg]:text-error!',
].join(' ')

export const menuContentClass = [
  'menu bg-base-100 text-base-content z-50 min-w-32 max-w-[calc(100vw-1rem)] flex-nowrap gap-0.5 overflow-x-hidden overflow-y-auto',
  'max-h-[calc(100dvh-1rem)] rounded-box border border-base-300 p-1 shadow-md outline-hidden',
  'data-placed:animate-in data-placed:fade-in-0 data-placed:zoom-in-95 data-placed:motion-reduce:[animation:none]',
  'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
].join(' ')

export function menuSlot(kind: 'dropdown' | 'context', name: string): string {
  return `${kind === 'context' ? 'context-menu' : 'dropdown-menu'}-${name}`
}
