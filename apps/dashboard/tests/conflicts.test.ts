import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conflictingPaths, planTransfer, type ConflictAnswer } from '../src/lib/conflicts.ts'

const existing = new Set(['Films', 'notes.txt'])

test('an item whose name is taken in the destination conflicts', () => {
  assert.deepEqual(conflictingPaths(['/a/Films', '/a/Photos', '/b/notes.txt'], '/dst', existing), ['/a/Films', '/b/notes.txt'])
})

test('an item copied into its own folder is not a conflict (it gets numbered)', () => {
  assert.deepEqual(conflictingPaths(['/dst/Films'], '/dst', existing), [])
})

test('each conflict is asked, the others go as they are', async () => {
  const asked: string[] = []
  const ask = async (src: string): Promise<ConflictAnswer> => { asked.push(src); return { choice: src.endsWith('Films') ? 'replace' : 'skip', all: false } }
  const plan = await planTransfer(['/a/Films', '/a/Photos', '/b/notes.txt'], '/dst', existing, ask)
  assert.deepEqual(asked, ['/a/Films', '/b/notes.txt'])
  assert.deepEqual(plan, [
    { src: '/a/Films', onConflict: 'replace' },
    { src: '/a/Photos', onConflict: 'rename' },
  ])
})

test('"apply to all" answers the remaining conflicts', async () => {
  let asks = 0
  const plan = await planTransfer(['/a/Films', '/b/notes.txt'], '/dst', existing, async () => { asks++; return { choice: 'keep', all: true } })
  assert.equal(asks, 1)
  assert.deepEqual(plan, [{ src: '/a/Films', onConflict: 'rename' }, { src: '/b/notes.txt', onConflict: 'rename' }])
})

test('cancelling stops the whole transfer', async () => {
  assert.equal(await planTransfer(['/a/Films'], '/dst', existing, async () => ({ choice: 'cancel', all: false })), null)
})

test('the remaining count is told to the question', async () => {
  const left: number[] = []
  await planTransfer(['/a/Films', '/b/notes.txt'], '/dst', existing, async (_src, remaining) => { left.push(remaining); return { choice: 'skip', all: false } })
  assert.deepEqual(left, [2, 1])
})
