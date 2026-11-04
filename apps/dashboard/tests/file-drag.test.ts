import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canDropInto } from '../src/lib/file-drag.ts'

const drag = (...paths: string[]) => ({ paths, dirs: [] })

test('items move into another folder', () => {
  assert.equal(canDropInto(drag('/srv/media/a.mkv'), '/srv/media/films'), true)
  assert.equal(canDropInto(drag('/srv/media/films/a.mkv'), '/srv/media'), true)
})

test('a folder never moves into itself or its insides', () => {
  assert.equal(canDropInto(drag('/srv/media/films'), '/srv/media/films'), false)
  assert.equal(canDropInto(drag('/srv/media/films'), '/srv/media/films/2024'), false)
  assert.equal(canDropInto(drag('/srv/media/films'), '/srv/media/films2'), true)
})

test('dropping where everything already is does nothing', () => {
  assert.equal(canDropInto(drag('/srv/media/a', '/srv/media/b'), '/srv/media'), false)
  assert.equal(canDropInto(drag('/srv/media/a', '/srv/docs/b'), '/srv/media'), true)
  assert.equal(canDropInto(null, '/srv'), false)
})
