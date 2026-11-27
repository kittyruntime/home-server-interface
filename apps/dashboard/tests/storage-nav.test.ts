import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNav, navOpen, navCrumbs, navTo, sectionOf, leavesWizard, SECTIONS, visibleSections } from '../src/lib/storage-nav.ts'

test('opening a section resets the stack to it', () => {
  let nav = createNav()
  assert.deepEqual(nav.current, { kind: 'section', section: 'overview' }, 'Storage opens on the overview')
  nav = navOpen(nav, { kind: 'disk', name: 'sdb' })
  nav = navOpen(nav, { kind: 'section', section: 'pools' })
  assert.equal(nav.stack.length, 1)
  assert.deepEqual(nav.current, { kind: 'section', section: 'pools' })
})

test('objects push on top of their section', () => {
  const nav = navOpen(createNav(), { kind: 'array', name: 'md0' })
  assert.deepEqual(nav.stack.map(l => l.kind), ['section', 'array'])
  assert.equal(sectionOf(nav.current), 'pools')
  assert.deepEqual(navCrumbs(nav).map(c => c.label), ['Pools', 'md0'])
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

test('the create volume wizard opens on top of Volumes', () => {
  const nav = navOpen(createNav({ kind: 'section', section: 'disks' }), { kind: 'create-volume', disks: ['sdf'] })
  assert.equal(sectionOf(nav.current), 'volumes')
  assert.deepEqual(navCrumbs(nav).map(c => c.label), ['Volumes', 'Create volume'])
})

test('the new volume replaces the wizard in the breadcrumb', () => {
  const nav = navOpen(navOpen(createNav(), { kind: 'create-volume' }), { kind: 'volume', id: 'U-1' })
  assert.deepEqual(nav.stack.map(l => l.kind), ['section', 'volume'])
})

test('leavesWizard: any move away from Create volume, by crumb or link', () => {
  const inWizard = navOpen(createNav(), { kind: 'create-volume' })
  assert.equal(leavesWizard(inWizard, navTo(inWizard, 0)), true, 'a breadcrumb back to Volumes')
  assert.equal(leavesWizard(inWizard, navOpen(inWizard, { kind: 'section', section: 'disks' })), true)
  assert.equal(leavesWizard(inWizard, inWizard), false)
  assert.equal(leavesWizard(createNav(), navOpen(createNav(), { kind: 'section', section: 'disks' })), false)
})

test('menus by function: one level, in this order', () => {
  assert.deepEqual(SECTIONS, ['overview', 'disks', 'pools', 'volumes', 'mounts', 'snapshots', 'maintenance'])
})

test('arrays, volume groups, ZFS pools and imports all live in Pools', () => {
  for (const loc of [{ kind: 'array', name: 'md0' }, { kind: 'vg', name: 'data' }, { kind: 'pool', name: 'tank' }, { kind: 'import' }] as const)
    assert.equal(sectionOf(loc), 'pools')
  assert.equal(sectionOf({ kind: 'disk', name: 'sdb' }), 'disks')
  assert.equal(sectionOf({ kind: 'create-volume' }), 'volumes')
  assert.deepEqual(navCrumbs(navOpen(createNav(), { kind: 'vg', name: 'data' })).map(c => c.label), ['Pools', 'data'])
})

test('opening an object of another section starts from that section', () => {
  let nav = navOpen(createNav({ kind: 'section', section: 'disks' }), { kind: 'disk', name: 'sdb' })
  nav = navOpen(nav, { kind: 'pool', name: 'tank' })
  assert.deepEqual(navCrumbs(nav).map(c => c.label), ['Pools', 'tank'])
})

test('Snapshots shows only when a type that has them is there', () => {
  assert.deepEqual(visibleSections({ snapshots: false }), ['overview', 'disks', 'pools', 'volumes', 'mounts', 'maintenance'])
  assert.deepEqual(visibleSections({ snapshots: true }), SECTIONS)
})
