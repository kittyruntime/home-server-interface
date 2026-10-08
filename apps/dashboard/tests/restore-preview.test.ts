import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backupLine, contentsLine, FOLLOW_UPS } from '../src/components/backup/restore-preview.ts'

test('backupLine says where and when the backup comes from', () => {
  assert.equal(backupLine({ hsiVersion: '1.64.2', createdAt: '2026-10-06T10:00:00Z', hostname: 'HSI' }, 2, 'en-GB'), 'HSI 1.64.2, 6 Oct 2026, from HSI')
  assert.equal(backupLine({}, 1, 'en-GB'), 'An older backup (database only)')
})

test('contentsLine counts with singulars and plurals', () => {
  assert.equal(contentsLine({ users: 1, groups: 0, places: 3, shares: 1, connectors: 2, apps: ['kuma'], volumes: 2 }),
    '1 account, 0 groups, 3 Places, 1 share, 2 notification connectors, 1 app (kuma), 2 volume descriptions')
})

test('FOLLOW_UPS lists what a restore leaves to do', () => {
  assert.deepEqual(FOLLOW_UPS.map(f => f.href), ['/?app=storage', '/?app=apps', '/?app=settings'])
})
