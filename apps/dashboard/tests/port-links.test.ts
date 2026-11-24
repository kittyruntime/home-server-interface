import assert from 'node:assert/strict'
import test from 'node:test'
import { portUrl } from '../src/lib/port-links.ts'

test('a TCP port opens on the LAN address', () => {
  assert.equal(portUrl({ hostPort: 8096, protocol: 'tcp' }, '192.168.1.10'), 'http://192.168.1.10:8096/')
  assert.equal(portUrl({ hostPort: 8096 }, '192.168.1.10'), 'http://192.168.1.10:8096/')
})

test('a UDP port is not a link', () => {
  assert.equal(portUrl({ hostPort: 19132, protocol: 'udp' }, '192.168.1.10'), null)
})

test('a port reached behind a proxy opens at its address', () => {
  assert.equal(portUrl({ hostPort: 8096, domain: 'media.example.com', tls: true }, '192.168.1.10'), 'https://media.example.com/')
  assert.equal(portUrl({ hostPort: 8096, domain: 'media.example.com', publicPort: 8443, tls: true }, ''), 'https://media.example.com:8443/')
})

test('an IPv6 host is bracketed, and no host gives no link', () => {
  assert.equal(portUrl({ hostPort: 80 }, 'fd00::1'), 'http://[fd00::1]:80/')
  assert.equal(portUrl({ hostPort: 80 }, ''), null)
})
