import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shareAddresses } from '../src/lib/share-address.ts'

const byOs = (list: { os: string; address: string }[]) => Object.fromEntries(list.map(a => [a.os, a.address]))

test('plain host', () => {
  assert.deepEqual(byOs(shareAddresses({ host: '192.168.1.222', share: 'Films' })), {
    windows: '\\\\192.168.1.222\\Films',
    macos: 'smb://192.168.1.222/Films',
    linux: 'smb://192.168.1.222/Films',
  })
})

test('discovery names', () => {
  const a = byOs(shareAddresses({ host: '192.168.1.222', share: 'Films', netbiosName: 'JELLYFIN', wsd: true, mdns: true }))
  assert.equal(a.windows, '\\\\JELLYFIN\\Films')
  assert.equal(a.macos, 'smb://JELLYFIN.local/Films')
  assert.equal(a.linux, 'smb://JELLYFIN.local/Films')
})

test('a discovery switch without a name keeps the address', () => {
  const a = byOs(shareAddresses({ host: '192.168.1.222', share: 'Films', wsd: true, mdns: true }))
  assert.equal(a.windows, '\\\\192.168.1.222\\Films')
})

test('ipv6 host', () => {
  const a = byOs(shareAddresses({ host: 'fe80::1', share: 'Films' }))
  assert.equal(a.macos, 'smb://[fe80::1]/Films')
  assert.equal(a.windows, '\\\\fe80--1.ipv6-literal.net\\Films')
})

test('share with a space', () => {
  const a = byOs(shareAddresses({ host: 'nas', share: 'My Films' }))
  assert.equal(a.macos, 'smb://nas/My%20Films')
  assert.equal(a.windows, '\\\\nas\\My Films')
})
