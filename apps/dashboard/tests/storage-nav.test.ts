import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNav, navOpen, navCrumbs, navTo, sectionOf, leavesWizard, TAB_SECTIONS, tabOf, defaultTab, createTabbedNav, tabbedOpen, switchTab, currentNav, visibleTabs } from '../src/lib/storage-nav.ts'

test('opening a section resets the stack to it', () => {
  let nav = createNav()
  assert.deepEqual(nav.current, { kind: 'section', section: 'volumes' }, 'Storage opens on Volumes')
  nav = navOpen(nav, { kind: 'disk', name: 'sdb' })
  nav = navOpen(nav, { kind: 'section', section: 'raid' })
  assert.equal(nav.stack.length, 1)
  assert.deepEqual(nav.current, { kind: 'section', section: 'raid' })
})

test('objects push on top of their section', () => {
  const nav = navOpen(createNav(), { kind: 'array', name: 'md0' })
  assert.deepEqual(nav.stack.map(l => l.kind), ['section', 'array'])
  assert.equal(sectionOf(nav.current), 'raid')
  assert.deepEqual(navCrumbs(nav).map(c => c.label), ['Arrays', 'md0'])
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

test('each section belongs to exactly one tab', () => {
  const all = Object.values(TAB_SECTIONS).flat()
  assert.equal(new Set(all).size, all.length)
  assert.deepEqual([...all].sort(), ['datasets', 'disks', 'lvm', 'maintenance', 'mounts', 'partitions', 'pools', 'raid', 'volumes', 'zfs-import'])
  assert.deepEqual(TAB_SECTIONS.lvm, ['volumes', 'raid', 'lvm', 'partitions', 'mounts'], 'partitioning and formatting live with LVM, not with the disks')
})

test('objects open in their tab', () => {
  assert.equal(tabOf({ kind: 'volume', id: 'U-1' }), 'lvm')
  assert.equal(tabOf({ kind: 'array', name: 'md0' }), 'lvm')
  assert.equal(tabOf({ kind: 'disk', name: 'sdb' }), 'disks')
  assert.equal(tabOf({ kind: 'create-volume' }), 'lvm')
})

test('default tab: Disks with no volume, LVM otherwise', () => {
  assert.equal(defaultTab({ volumes: 0 }), 'disks')
  assert.equal(defaultTab({ volumes: 2 }), 'lvm')
})

test('opening an object of another tab switches tab and keeps a valid breadcrumb', () => {
  let t = tabbedOpen(createTabbedNav('disks'), { kind: 'disk', name: 'sdb' })
  t = tabbedOpen(t, { kind: 'volume', id: 'U-1' })
  assert.equal(t.tab, 'lvm')
  assert.deepEqual(navCrumbs(currentNav(t)).map(c => c.label), ['Volumes', 'U-1'])
})

test('switching tabs keeps where each tab was', () => {
  let t = tabbedOpen(createTabbedNav('lvm'), { kind: 'array', name: 'md0' })
  t = switchTab(t, 'maintenance')
  assert.deepEqual(currentNav(t).current, { kind: 'section', section: 'maintenance' })
  t = switchTab(t, 'lvm')
  assert.deepEqual(currentNav(t).current, { kind: 'array', name: 'md0' })
})

test('a link into another tab starts that tab from its section, not from where it was left', () => {
  let t = tabbedOpen(createTabbedNav('lvm'), { kind: 'volume', id: 'A' })
  t = tabbedOpen(t, { kind: 'disk', name: 'sda' })
  t = tabbedOpen(t, { kind: 'volume', id: 'B' })
  assert.deepEqual(navCrumbs(currentNav(t)).map(c => c.label), ['Volumes', 'B'])
  let d = tabbedOpen(createTabbedNav('disks'), { kind: 'disk', name: 'sdb' })
  d = tabbedOpen(d, { kind: 'volume', id: 'A' })
  d = tabbedOpen(d, { kind: 'disk', name: 'sdc' })
  assert.deepEqual(navCrumbs(currentNav(d)).map(c => c.label), ['Disks', 'sdc'])
})

test('a free bay opens the wizard on top of Volumes, whatever the LVM tab showed', () => {
  let t = tabbedOpen(createTabbedNav('lvm'), { kind: 'volume', id: 'A' })
  t = switchTab(t, 'disks')
  t = tabbedOpen(t, { kind: 'create-volume', disks: ['sdf'] })
  assert.deepEqual(navCrumbs(currentNav(t)).map(c => c.label), ['Volumes', 'Create volume'])
})

test('the ZFS tab has pools, datasets and import; a pool opens in it', () => {
  assert.deepEqual(TAB_SECTIONS.zfs, ['pools', 'datasets', 'zfs-import'])
  assert.equal(tabOf({ kind: 'pool', name: 'tank' }), 'zfs')
  assert.deepEqual(navCrumbs(currentNav(tabbedOpen(createTabbedNav('disks'), { kind: 'pool', name: 'tank' }))).map(c => c.label), ['Pools', 'tank'])
})

test('the ZFS tab shows only when the host has ZFS', () => {
  assert.deepEqual(visibleTabs({ zfs: false }), ['disks', 'lvm', 'maintenance'])
  assert.deepEqual(visibleTabs({ zfs: true }), ['disks', 'lvm', 'zfs', 'maintenance'])
})

test('Storage opens on ZFS when it holds most volumes', () => {
  assert.equal(defaultTab({ volumes: 1, zfsVolumes: 3 }), 'zfs')
  assert.equal(defaultTab({ volumes: 3, zfsVolumes: 1 }), 'lvm')
  assert.equal(defaultTab({ volumes: 0, zfsVolumes: 0 }), 'disks')
})
