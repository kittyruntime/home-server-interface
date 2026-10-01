import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deviceRole, isFreeDisk, memberOwner } from '../src/components/storage/device-state.ts'

test('membership comes from the worker usage and owner', () => {
  assert.deepEqual(deviceRole({ usage: 'raid-member', owner: 'md0', fstype: 'linux_raid_member' }), { kind: 'raid', owner: 'md0' })
  assert.deepEqual(deviceRole({ usage: 'lvm-pv', owner: 'data', fstype: 'LVM2_member' }), { kind: 'lvm', owner: 'data' })
  assert.deepEqual(deviceRole({ usage: 'raid-member', fstype: 'linux_raid_member' }), { kind: 'raid', owner: null })
  assert.equal(deviceRole({ usage: 'free', fstype: '' }), null)
  assert.equal(deviceRole({ usage: 'mounted', fstype: 'ext4' }), null)
})

test('older workers without usage fall back to the on-disk signature', () => {
  assert.deepEqual(deviceRole({ fstype: 'linux_raid_member' }), { kind: 'raid', owner: null })
  assert.deepEqual(deviceRole({ fstype: 'LVM2_member' }), { kind: 'lvm', owner: null })
})

test('memberOwner names the array or volume group of a member', () => {
  assert.equal(memberOwner({ usage: 'raid-member', owner: 'md0', fstype: '' }, 'raid'), 'md0')
  assert.equal(memberOwner({ usage: 'raid-member', owner: 'md0', fstype: '' }, 'lvm'), undefined)
  assert.equal(memberOwner({ usage: 'lvm-pv', fstype: '' }, 'lvm'), undefined)
})

test('a free disk is a whole, non-system disk with nothing on it', () => {
  assert.equal(isFreeDisk({ type: 'disk', usage: 'free', isSystem: false, size: 1e12, fstype: '' }), true)
  assert.equal(isFreeDisk({ type: 'disk', usage: 'free', isSystem: false, size: 0, fstype: '' }), false, 'empty device')
  assert.equal(isFreeDisk({ type: 'disk', usage: 'free', isSystem: true, size: 1e12, fstype: '' }), false)
  assert.equal(isFreeDisk({ type: 'part', usage: 'free', isSystem: false, size: 1e12, fstype: '' }), false)
  assert.equal(isFreeDisk({ type: 'disk', usage: 'partitioned', isSystem: false, size: 1e12, fstype: '' }), false)
})
