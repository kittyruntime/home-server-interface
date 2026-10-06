import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actionLabel } from '../src/lib/audit-labels.ts'

// Every action the backend logs on a real server reads as words.
const LOGGED = ['alert.clear', 'apps.apply', 'apps.plan', 'auth.login', 'catalog.install', 'container.app.apply', 'container.app.remove',
  'container.app.update', 'files.upload', 'fs.chmod', 'fs.chown', 'fs.delete', 'fs.mkdir', 'fs.rename', 'fs.touch',
  'notifications.connectors.create', 'notifications.markAllRead', 'notifications.renderPreview', 'notifications.rules.update',
  'notifications.testConnector', 'place.create', 'place.delete', 'storage.apply', 'storage.createLv', 'storage.createPartition',
  'storage.createPv', 'storage.createRaid', 'storage.createVg', 'storage.deletePartition', 'storage.failRaidMember', 'storage.formatDisk',
  'storage.mountDevice', 'storage.plan', 'storage.removeLv', 'storage.removeVg', 'storage.runMaintenanceNow', 'storage.stopRaid',
  'storage.umountDevice', 'storage.volumeApply', 'storage.volumePlan', 'storage.volumeRemoveApply', 'storage.volumeRemovePlan',
  'update.apply', 'update.check', 'update.rebootHost', 'user.changePassword', 'user.updatePreferences']

test('every logged action has a label, not its raw key', () => {
  for (const a of LOGGED) {
    const l = actionLabel(a)
    assert.ok(!l.includes('.') && /^[A-Z]/.test(l) && l !== a, `${a} -> ${l}`)
  }
})

test('an unknown action still reads as words', () => {
  assert.equal(actionLabel('widgets.resetLayoutNow'), 'Widgets: reset layout now')
  assert.equal(actionLabel('ping'), 'Ping')
})
