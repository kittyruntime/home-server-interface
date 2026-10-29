import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextMaintenanceStep, maintenanceStepState } from '../src/lib/maintenance-step.ts'

test('maintenance steps follow the server', () => {
  assert.equal(nextMaintenanceStep('scheduled', true, true), 'working')
  assert.equal(nextMaintenanceStep('working', false, false), 'offline')
  assert.equal(nextMaintenanceStep('offline', true, false), 'done')
  // A restart no poll saw offline still ends.
  assert.equal(nextMaintenanceStep('working', true, false), 'done')
})

test('maintenance steps never go back', () => {
  assert.equal(nextMaintenanceStep('offline', true, true), 'offline')
  assert.equal(nextMaintenanceStep('done', false, false), 'done')
})

test('step states', () => {
  assert.equal(maintenanceStepState('offline', 'scheduled'), 'done')
  assert.equal(maintenanceStepState('offline', 'offline'), 'active')
  assert.equal(maintenanceStepState('offline', 'done'), 'pending')
  assert.equal(maintenanceStepState('done', 'done'), 'done')
})
