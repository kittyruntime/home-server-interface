import type { ActivityItem } from './activity'

// "Copying Films to Archives": what a background task works on, from the
// metadata stored with it. A task whose details are hidden (a system task seen
// by a non-admin) or missing gets the generic label of its kind.

type Translate = (key: string, params?: Record<string, unknown>) => string

const last = (path?: string) => (path ? path.replace(/\/+$/, '').split('/').pop() || path : undefined)

const NEEDS: Record<string, Array<'src' | 'dst' | 'name'>> = {
  copy: ['src', 'dst'],
  move: ['src', 'dst'],
  delete: ['src'],
  zip: ['name'],
  unzip: ['src', 'dst'],
  finalize: ['dst'],
  container: ['name'],
  backup: ['name'],
  update: ['name'],
  upload: ['name', 'dst'],
}

export function activityLabel(item: ActivityItem, t: Translate): string {
  const needs = NEEDS[item.kind]
  const params = {
    src: last(item.meta.src),
    dst: last(item.meta.dst),
    name: item.meta.name,
  }
  if (!needs || needs.some(k => !params[k])) return t(`activity.taskGeneric.${needs ? item.kind : 'other'}`)
  return t(`activity.task.${item.kind}`, Object.fromEntries(needs.map(k => [k, params[k]])))
}

export type NotifiedTask = 'copy' | 'move' | 'delete' | 'zip' | 'unzip' | 'container' | 'other'

/** The task a notification is about, from its job action (fs.copy, container.composeUp...). */
export function taskKindOf(action: string): NotifiedTask {
  if (action.startsWith('container.')) return 'container'
  const kind = action.replace(/^fs\./, '')
  return (['copy', 'move', 'delete', 'zip', 'unzip'] as const).find(k => k === kind) ?? 'other'
}
