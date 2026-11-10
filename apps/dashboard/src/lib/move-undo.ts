// Undoing a move: every item goes back to the folder it came from, and takes
// back its name if a conflict had numbered it ("Films (1)" back to "Films").

const nameOf = (path: string) => path.split('/').pop() || path
const parentOf = (path: string) => {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export interface MovedItem { from: string; to: string }

export function undoPlan(moved: MovedItem[]): Array<{ src: string; dstDir: string; name: string }> {
  return moved.map(m => ({ src: m.to, dstDir: parentOf(m.from), name: nameOf(m.from) }))
}
