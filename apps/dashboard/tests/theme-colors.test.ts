import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withAlpha } from '../src/lib/theme-colors.ts'

test('withAlpha turns an rgb color into rgba', () => {
  assert.equal(withAlpha('rgb(10, 20, 30)', 0.1), 'rgba(10, 20, 30, 0.1)')
})

test('withAlpha replaces the alpha of an rgba color', () => {
  assert.equal(withAlpha('rgba(10, 20, 30, 0.9)', 0.25), 'rgba(10, 20, 30, 0.25)')
})

test('withAlpha tolerates the space separated syntax', () => {
  assert.equal(withAlpha('rgb(10 20 30)', 0.5), 'rgba(10, 20, 30, 0.5)')
  assert.equal(withAlpha('rgb(10 20 30 / 40%)', 0.5), 'rgba(10, 20, 30, 0.5)')
})

test('withAlpha clamps alpha to 0..1', () => {
  assert.equal(withAlpha('rgb(1, 2, 3)', 2), 'rgba(1, 2, 3, 1)')
  assert.equal(withAlpha('rgb(1, 2, 3)', -1), 'rgba(1, 2, 3, 0)')
})

test('withAlpha returns an unparsable color unchanged', () => {
  assert.equal(withAlpha('red', 0.5), 'red')
})
