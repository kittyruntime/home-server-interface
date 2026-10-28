import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNyan } from '../src/components/file-browser/nyan.ts'

test('anything named nyan, whatever its case or extension, is the nyan cat', () => {
  for (const name of ['nyan', 'Nyan', 'NYAN', 'nyan.gif', 'Nyan.mp4']) assert.ok(isNyan(name), name)
  for (const name of ['nyancat', 'my-nyan', '.nyan', 'nyan2.png']) assert.ok(!isNyan(name), name)
})
