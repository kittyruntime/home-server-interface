import { Socket } from 'node:net'

// A UPS through Network UPS Tools (upsd on port 3493), when one is installed.
// The protocol is plain text: LIST UPS, then LIST VAR <ups> for each.

export type UpsReading = {
  name: string
  model: string
  /** OL on line, OB on battery, LB low battery, CHRG charging, ... */
  status: string[]
  charge: number | null
  runtimeS: number | null
  loadPct: number | null
}

/** `VAR <ups> <key> "<value>"` lines into a map; also reads `UPS <name> "<desc>"`. */
export function parseNutLines(text: string, kind: 'VAR' | 'UPS'): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const line of text.split('\n')) {
    const m = kind === 'VAR' ? /^VAR \S+ (\S+) "(.*)"$/.exec(line.trim()) : /^UPS (\S+) "(.*)"$/.exec(line.trim())
    if (m) out.push([m[1]!, m[2]!.replace(/\\(.)/g, '$1')])
  }
  return out
}

export function upsFromVars(name: string, vars: Map<string, string>): UpsReading {
  const n = (k: string) => { const v = vars.get(k); const x = v == null ? NaN : Number(v); return Number.isFinite(x) ? x : null }
  return {
    name,
    model: [vars.get('device.mfr') ?? vars.get('ups.mfr'), vars.get('device.model') ?? vars.get('ups.model')].filter(Boolean).join(' ').trim() || name,
    status: (vars.get('ups.status') ?? '').split(/\s+/).filter(Boolean),
    charge: n('battery.charge'),
    runtimeS: n('battery.runtime'),
    loadPct: n('ups.load'),
  }
}

function session(host: string, port: number, timeoutMs: number) {
  const sock = new Socket()
  let buf = ''
  let waiter: { end: string; resolve: (s: string) => void; reject: (e: Error) => void } | null = null
  const fail = (e: Error) => { waiter?.reject(e); waiter = null; sock.destroy() }
  sock.setTimeout(timeoutMs, () => fail(new Error('NUT timed out')))
  sock.on('error', fail)
  sock.on('data', chunk => {
    buf += chunk.toString('utf8')
    if (buf.length > 256 * 1024) return fail(new Error('NUT reply too large'))
    if (!waiter) return
    if (buf.startsWith('ERR')) return fail(new Error(buf.split('\n')[0]))
    const at = buf.indexOf(waiter.end)
    if (at >= 0) { const out = buf.slice(0, at); buf = ''; const w = waiter; waiter = null; w.resolve(out) }
  })
  const connected = new Promise<void>((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject) })
  sock.connect(port, host)
  return {
    async ask(cmd: string, end: string): Promise<string> {
      await connected
      return new Promise((resolve, reject) => { waiter = { end, resolve, reject }; sock.write(cmd + '\n') })
    },
    close() { sock.end('LOGOUT\n'); sock.destroy() },
  }
}

/** Every UPS upsd knows about, or null when no upsd answers. */
export async function readUps(host = '127.0.0.1', port = 3493, timeoutMs = 1500): Promise<UpsReading[] | null> {
  const s = session(host, port, timeoutMs)
  try {
    const list = parseNutLines(await s.ask('LIST UPS', 'END LIST UPS'), 'UPS')
    const out: UpsReading[] = []
    for (const [name] of list.slice(0, 8)) {
      const vars = new Map(parseNutLines(await s.ask(`LIST VAR ${name}`, `END LIST VAR ${name}`), 'VAR'))
      out.push(upsFromVars(name, vars))
    }
    return out
  } catch {
    return null
  } finally {
    s.close()
  }
}
