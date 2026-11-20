import type { trpc } from '../../lib/trpc'

export type ListedSource = Awaited<ReturnType<typeof trpc.widgetSource.list.query>>[number]
/** A source as an admin edits it. */
export type EditableSource = Extract<ListedSource, { editable: true }>
