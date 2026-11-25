import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chipKind, hottest, sensorKey, tempLevel, tempTone, type Sensor } from '../src/lib/perf-temps.ts'

const temp = (label: string, value: number, extra: Partial<Sensor> = {}): Sensor => ({ chip: 'coretemp', label, kind: 'temp', value, ...extra })

test('tone: warm at the sensor max or 80 C, bad within 5 C of critical', () => {
  assert.equal(tempTone(temp('a', 45)), 'ok')
  assert.equal(tempTone(temp('a', 80)), 'warn')
  assert.equal(tempTone(temp('a', 70, { max: 70 })), 'warn')
  assert.equal(tempTone(temp('a', 95, { crit: 100 })), 'bad')
  assert.equal(tempTone(temp('a', 94, { crit: 100 })), 'warn')
})

test('the hottest temperature, fans left out', () => {
  const list: Sensor[] = [temp('a', 40), { chip: 'nct', label: 'fan1', kind: 'fan', value: 1200 }, temp('b', 61), temp('c', 52)]
  assert.equal(hottest(list)?.label, 'b')
  assert.equal(hottest([{ chip: 'nct', label: 'fan1', kind: 'fan', value: 900 }]), null)
  assert.equal(hottest([]), null)
})

test('level: against the critical point, else against 100 C, clamped', () => {
  assert.equal(tempLevel(temp('a', 50, { crit: 100 })), 50)
  assert.equal(tempLevel(temp('a', 42)), 42)
  assert.equal(tempLevel(temp('a', 120, { crit: 100 })), 100)
})

test('a sensor is keyed by chip and label', () => {
  assert.equal(sensorKey(temp('Package id 0', 40)), 'coretemp:Package id 0')
})

test('known chips are named by what they measure', () => {
  assert.equal(chipKind('k10temp'), 'cpu')
  assert.equal(chipKind('cpu_thermal'), 'cpu')
  assert.equal(chipKind('nvme'), 'nvme')
  assert.equal(chipKind('mystery'), null)
})
