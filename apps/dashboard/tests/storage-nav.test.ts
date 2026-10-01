import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNav, takeRequest, navOpen, navBack, navCrumbs, navTo, sectionOf } from '../src/lib/storage-nav.ts'

test('opening a section resets the stack to it', () => {
  let nav = createNav()
  assert.deepEqual(nav.current, { kind: 'section', section: 'volumes' }, 'Storage opens on Volumes')
  nav = navOpen(nav, { kind: 'disk', name: 'sdb' })
  nav = navOpen(nav, { kind: 'section', section: 'raid' })
  assert.equal(nav.stack.length, 1)
  assert.deepEqual(nav.current, { kind: 'section', section: 'raid' })
})

test('objects push on top of their section, back pops', () => {
  let nav = navOpen(createNav(), { kind: 'array', name: 'md0' })
  assert.deepEqual(nav.stack.map(l => l.kind), ['section', 'array'])
  assert.equal(sectionOf(nav.current), 'raid')
  assert.deepEqual(navCrumbs(nav).map(c => c.label), ['Arrays', 'md0'])
  nav = navBack(nav)
  assert.deepEqual(nav.current, { kind: 'section', section: 'raid' })
  assert.equal(navBack(nav).stack.length, 1, 'back never empties the stack')
})

test('opening the current location again does not grow the stack', () => {
  let nav = navOpen(createNav(), { kind: 'disk', name: 'sdb' })
  nav = navOpen(nav, { kind: 'disk', name: 'sdb' })
  assert.equal(nav.stack.length, 2)
})

test('navTo returns to an earlier crumb', () => {
  let nav = navOpen(createNav(), { kind: 'disk', name: 'sdb' })
  nav = navTo(nav, 0)
  assert.deepEqual(nav.stack, [{ kind: 'section', section: 'disks' }])
  assert.equal(navTo(nav, 5).stack.length, 1, 'an index past the stack keeps it')
})

test('a volume opens on top of Volumes', () => {
  const nav = navOpen(createNav(), { kind: 'volume', id: 'U-1' })
  assert.equal(sectionOf(nav.current), 'volumes')
  assert.deepEqual(navCrumbs(nav).map(c => c.label), ['Volumes', 'U-1'])
  assert.deepEqual(navCrumbs(nav, { 'volume:U-1': 'data' }).map(c => c.label), ['Volumes', 'data'])
})

test('arrays and volume groups open on their renamed sections', () => {
  assert.deepEqual(navCrumbs(navOpen(createNav(), { kind: 'array', name: 'md0' })).map(c => c.label), ['Arrays', 'md0'])
  assert.deepEqual(navCrumbs(navOpen(createNav(), { kind: 'vg', name: 'data' })).map(c => c.label), ['Volume groups', 'data'])
  assert.deepEqual(navCrumbs(navOpen(createNav(), { kind: 'disk', name: 'sdb' })).map(c => c.label), ['Disks', 'sdb'])
})

test('a requested location expires if no Storage panel takes it', () => {
  const req = { loc: { kind: 'disk', name: 'sdb' } as const, at: 1000 }
  assert.deepEqual(takeRequest(req, 5000), req.loc)
  assert.equal(takeRequest(req, 1000 + 11_000), null)
  assert.equal(takeRequest(null, 1000), null)
})

test('the create volume wizard opens on top of Volumes', () => {
  const nav = navOpen(createNav({ kind: 'section', section: 'disks' }), { kind: 'create-volume', disks: ['sdf'] })
  assert.equal(sectionOf(nav.current), 'volumes')
  assert.deepEqual(navCrumbs(nav).map(c => c.label), ['Volumes', 'Create volume'])
})
