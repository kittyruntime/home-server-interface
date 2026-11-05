import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectKind } from '../src/lib/file-kind.ts'
import { isTouchClick } from '../src/lib/touch.ts'

test('a PDF opens in the PDF preview, other documents in the text one', () => {
  assert.equal(detectKind('Report.PDF'), 'pdf')
  assert.equal(detectKind('notes.md'), 'text')
  assert.equal(detectKind('photo.jpg'), 'image')
})

test('a tap is told apart from a mouse click', () => {
  const click = (pointerType?: string) => ({ pointerType } as unknown as MouseEvent)
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
