import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rollbackPlan, updatePlan, updateText } from '../src/lib/app-update.ts'

test('updateText names both versions', () => {
  assert.equal(updateText({ from: '1.23.15', to: '1.23.16' }), 'Update available: 1.23.15 → 1.23.16')
})

test('updatePlan titles the plan with the app and the target version', () => {
  assert.deepEqual(updatePlan('uptime-kuma', { from: '1.23.15', to: '1.23.16' }),
    { title: 'Update uptime-kuma to 1.23.16', actionLabel: 'Update' })
})

test('rollbackPlan names the version it goes back to', () => {
  assert.deepEqual(rollbackPlan('uptime-kuma', '1.23.15'),
    { title: 'Roll back uptime-kuma to 1.23.15', actionLabel: 'Roll back' })
})
