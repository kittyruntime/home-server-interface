import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectKind } from '../src/lib/file-kind.ts'
import { isTouchClick, setLastPointerDownForTests } from '../src/lib/touch.ts'

test('a PDF opens in the PDF preview, other documents in the text one', () => {
  assert.equal(detectKind('Report.PDF'), 'pdf')
  assert.equal(detectKind('notes.md'), 'text')
  assert.equal(detectKind('photo.jpg'), 'image')
})

test('a tap is told apart from a mouse click', () => {
  setLastPointerDownForTests(null)
  const click = (pointerType?: string) => ({ pointerType, timeStamp: 5000 } as unknown as MouseEvent)
  assert.equal(isTouchClick(click('touch')), true)
  assert.equal(isTouchClick(click('pen')), true)
  assert.equal(isTouchClick(click('mouse')), false)
  // No pointer type (keyboard, older browser): the device decides.
  const g = globalThis as { window?: unknown }
  g.window = { matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' }) }
  assert.equal(isTouchClick(click('')), true)
  g.window = { matchMedia: () => ({ matches: false }) }
  assert.equal(isTouchClick(click(undefined)), false)
  delete g.window
})

test('iOS: a tap whose click says mouse is still a tap, by its pointerdown', () => {
  const click = (pointerType: string, timeStamp: number) => ({ pointerType, timeStamp } as unknown as MouseEvent)
  setLastPointerDownForTests('touch', 1000)
  assert.equal(isTouchClick(click('mouse', 1100)), true)
  setLastPointerDownForTests('mouse', 1000)
  assert.equal(isTouchClick(click('mouse', 1100)), false)
  // A pointerdown long before (a keyboard click later) no longer decides.
  setLastPointerDownForTests('touch', 1000)
  assert.equal(isTouchClick(click('mouse', 5000)), false)
  setLastPointerDownForTests(null)
})
