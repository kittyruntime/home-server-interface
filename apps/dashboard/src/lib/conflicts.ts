import { ref } from 'vue'

// Copying or moving onto a name already taken asks what to do, like a file
// explorer: replace the existing item, keep both (the new one is numbered), or
// skip it, optionally for every remaining conflict.

export type ConflictChoice = 'replace' | 'keep' | 'skip'
export interface ConflictAnswer { choice: ConflictChoice | 'cancel'; all: boolean }
export type OnConflict = 'rename' | 'replace'

const nameOf = (path: string) => path.split('/').pop() || path
const parentOf = (path: string) => {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

/** The items whose name is already taken in dst (an item copied into its own folder is numbered, not a conflict). */
export function conflictingPaths(paths: string[], dst: string, existing: Set<string>): string[] {
  return paths.filter(p => existing.has(nameOf(p)) && parentOf(p) !== dst)
}

/**
 * The transfer to run: each item with what to do on a conflict, the skipped
 * ones left out; null when the user cancels. ask gets the item and how many
 * conflicts are left, this one included.
 */
export async function planTransfer(
  paths: string[], dst: string, existing: Set<string>,
  ask: (src: string, remaining: number) => Promise<ConflictAnswer>,
): Promise<Array<{ src: string; onConflict: OnConflict }> | null> {
  const conflicts = new Set(conflictingPaths(paths, dst, existing))
  let remembered: ConflictChoice | null = null
  let left = conflicts.size
  const plan: Array<{ src: string; onConflict: OnConflict }> = []
  for (const src of paths) {
    if (!conflicts.has(src)) { plan.push({ src, onConflict: 'rename' }); continue }
    let choice: ConflictChoice | null = remembered
    if (!choice) {
      const answer = await ask(src, left)
      if (answer.choice === 'cancel') return null
      choice = answer.choice
      if (answer.all) remembered = choice
    }
    left--
    if (choice === 'skip') continue
    plan.push({ src, onConflict: choice === 'replace' ? 'replace' : 'rename' })
  }
  return plan
}

// ── The question, rendered by <ConflictDialog/> in the dashboard shell ──────

export interface ConflictQuestion {
  id: number
  name: string
  dir: string
  isDir: boolean
  remaining: number
  resolve: (a: ConflictAnswer) => void
}

export const conflictQuestion = ref<ConflictQuestion | null>(null)
let nextId = 0

export function askConflict(q: Omit<ConflictQuestion, 'id' | 'resolve'>): Promise<ConflictAnswer> {
  return new Promise(resolve => {
    conflictQuestion.value?.resolve({ choice: 'cancel', all: false })
    conflictQuestion.value = { ...q, id: nextId++, resolve }
  })
}
