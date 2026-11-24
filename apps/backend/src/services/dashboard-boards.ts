import { z } from 'zod'

// Dashboards: each account keeps its own tabs of widgets; an admin can publish a
// set every account without its own starts from. Widgets are validated loosely
// (any well-formed type is kept) so a board written by a newer release still
// loads, and the dashboard skips the types it does not know.

export const MAX_BOARDS = 12
export const MAX_WIDGETS = 48
const MAX_SETTINGS = 4000

const zWidget = z.object({
  id: z.string().min(1).max(64),
  type: z.string().min(1).max(48).regex(/^[a-z][a-z0-9.-]*$/),
  size: z.enum(['s', 'm', 'l']).catch('s'),
  settings: z.record(z.string(), z.unknown()).optional().catch(undefined)
    .refine(s => s === undefined || JSON.stringify(s).length <= MAX_SETTINGS, 'Widget settings are too large'),
})
export type BoardWidget = z.infer<typeof zWidget>

export const zBoardInput = z.object({
  name: z.string().trim().min(1).max(40),
  widgets: z.array(zWidget).max(MAX_WIDGETS),
})
export type BoardInput = z.infer<typeof zBoardInput>
export const zBoardsInput = z.object({ boards: z.array(zBoardInput).min(1).max(MAX_BOARDS) })

export type BoardRow = { id: string; name: string; widgets: string }
export type BoardView = { id: string; name: string; widgets: BoardWidget[] }

/** The widgets stored on a board; malformed entries are dropped, not fatal. */
export function parseWidgets(text: string): BoardWidget[] {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const out: BoardWidget[] = []
  for (const item of raw) {
    const r = zWidget.safeParse(item)
    if (r.success) out.push(r.data)
    if (out.length >= MAX_WIDGETS) break
  }
  return out
}

export const boardView = (row: BoardRow): BoardView => ({ id: row.id, name: row.name, widgets: parseWidgets(row.widgets) })

type BoardStore = {
  dashboardBoard: {
    deleteMany(args: { where: { ownerId: string | null } }): Promise<unknown>
    create(args: { data: { ownerId: string | null; name: string; position: number; widgets: string } }): Promise<BoardRow>
  }
}

/** Replaces every board of an owner (null: the published set) in one transaction. */
export async function replaceBoards(
  prisma: { $transaction<T>(fn: (tx: BoardStore) => Promise<T>): Promise<T> },
  ownerId: string | null,
  boards: BoardInput[],
): Promise<BoardView[]> {
  return prisma.$transaction(async tx => {
    await tx.dashboardBoard.deleteMany({ where: { ownerId } })
    const rows: BoardRow[] = []
    for (const [position, b] of boards.entries()) {
      rows.push(await tx.dashboardBoard.create({ data: { ownerId, name: b.name, position, widgets: JSON.stringify(b.widgets) } }))
    }
    return rows.map(boardView)
  })
}
