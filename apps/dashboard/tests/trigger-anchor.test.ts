import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// A Button with a tooltip is not its own root element (the tooltip wraps it),
// so a menu or popover trigger with as-child would have nothing to anchor to
// and open in the corner. The tooltip goes around the trigger instead.
function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return vueFiles(path)
    return path.endsWith('.vue') ? [path] : []
  })
}

test('no as-child trigger wraps a Button that has its own tooltip', () => {
  const offenders: string[] = []
  for (const file of vueFiles(join(import.meta.dirname, '..', 'src'))) {
    const src = readFileSync(file, 'utf8')
    const re = /<\w*Trigger\b[^>]*\bas-child\b[^>]*>\s*<Button\b([^>]*)>/g
    for (const m of src.matchAll(re)) {
      if (/(^|\s):?tooltip=/.test(m[1]!)) offenders.push(file.slice(file.indexOf('src/')))
    }
  }
  assert.deepEqual(offenders, [])
})
