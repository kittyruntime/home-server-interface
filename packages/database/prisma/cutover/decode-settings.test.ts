import assert from "node:assert/strict"
import test from "node:test"
import { decodeSetting } from "./decode-settings"

const fields = {
  ports: "object", volumes: "object", envs: "object", networkNames: "string",
  labels: "object", capAdd: "string", capDrop: "string", extraHosts: "string",
} as const

for (const [field, itemKind] of Object.entries(fields)) {
  test(`${field} rejects valid JSON with the wrong shape and names the app and field`, () => {
    assert.throws(() => decodeSetting("null", [], "sample-app", field, itemKind), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /sample-app/)
      assert.match(error.message, new RegExp(field))
      assert.doesNotMatch(error.message, /TypeError|Cannot read properties|is not a function/)
      return true
    })
  })
}

test("rejects a null volume entry with context", () => {
  assert.throws(() => decodeSetting("[null]", [], "sample-app", "volumes", "object"), /sample-app.*volumes/)
})

for (const [field, value] of [["ports", '{"a":1}'], ["ports", '"x"'], ["volumes", "{}"]] as const) {
  test(`${field} rejects ${value} with context`, () => {
    assert.throws(() => decodeSetting(value, [], "sample-app", field, "object"), /sample-app.*(ports|volumes)/)
  })
}

test("unparseable JSON keeps the warning and fallback", () => {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = message => warnings.push(String(message))
  try {
    assert.deepEqual(decodeSetting("broken-json", [], "sample-app", "ports", "object"), [])
  } finally {
    console.warn = originalWarn
  }
  assert.deepEqual(warnings, ['warning: application "sample-app": invalid ports settings were skipped'])
})
