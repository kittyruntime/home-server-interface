import { test } from 'node:test'
import assert from 'node:assert/strict'
import { undoPlan } from '../src/lib/move-undo.ts'

test('undoing a move sends each item back to the folder it came from, under its new name', () => {
  assert.deepEqual(undoPlan([
    { from: '/srv/a/zelda.zip', to: '/srv/games/zelda.zip' },
    { from: '/srv/b/Films', to: '/srv/games/Films (1)' },
  ]), [
    { src: '/srv/games/zelda.zip', dstDir: '/srv/a', name: 'zelda.zip' },
    { src: '/srv/games/Films (1)', dstDir: '/srv/b', name: 'Films' },
  ])
})

test('an item from the root goes back to /', () => {
  assert.deepEqual(undoPlan([{ from: '/x', to: '/srv/x' }]), [{ src: '/srv/x', dstDir: '/', name: 'x' }])
})
