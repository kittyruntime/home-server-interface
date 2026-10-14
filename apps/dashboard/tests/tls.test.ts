import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addressAfter, expiryState, modeLabel } from '../src/lib/tls.ts'

test('modeLabel names each mode', () => {
  assert.equal(modeLabel('local'), 'HTTPS, local authority')
  assert.equal(modeLabel('off'), 'Plain HTTP')
})

test('expiryState warns under 30 days and after expiry', () => {
  const now = new Date('2026-10-13T00:00:00Z')
  assert.deepEqual(expiryState('2027-01-01T00:00:00Z', now), { level: 'ok', days: 80 })
  assert.deepEqual(expiryState('2026-10-23T00:00:00Z', now), { level: 'soon', days: 10 })
  assert.equal(expiryState('2026-10-12T00:00:00Z', now).level, 'expired')
})

test('addressAfter keeps the host and path and moves scheme and port', () => {
  const loc = { protocol: 'http:', hostname: '192.168.1.48', port: '9001', pathname: '/' }
  assert.equal(addressAfter(loc, { https: true, port: 9001, standardPorts: false }), 'https://192.168.1.48:9001/')
  assert.equal(addressAfter({ ...loc, protocol: 'https:' }, { https: true, port: 9001, standardPorts: true }), 'https://192.168.1.48/')
  assert.equal(addressAfter({ ...loc, protocol: 'https:' }, { https: false, port: 9001, standardPorts: false }), 'http://192.168.1.48:9001/')
  assert.equal(addressAfter({ protocol: 'http:', hostname: 'nas', port: '', pathname: '/' }, { https: false, port: 9001, standardPorts: false }), 'http://nas/', 'behind a proxy on 80: stay where the page is')
})
