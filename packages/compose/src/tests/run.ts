import assert from "node:assert/strict"
import { generateComposeYaml, parseComposeYaml } from "../compose.js"
import { STACK_NAME_RE, type AppInput } from "../model.js"

const base: AppInput = {
  name: "jellyfin", image: "jellyfin/jellyfin:latest",
  ports: [{ hostPort: 8096, containerPort: 8096, protocol: "tcp", domain: "media.example.com", tls: true, publicPort: 443 }],
  envs: [{ key: "TZ", value: "Europe/Paris" }],
  volumes: [{ type: "bind", source: "/srv/media", target: "/media", readOnly: false }],
  networkNames: ["hsi-net"], labels: [{ key: "hsi.catalog.id", value: "jellyfin" }],
  capAdd: [], capDrop: [], extraHosts: [], restartPolicy: "unless-stopped",
  hostname: null, user: null, command: null, cpuLimit: null, memoryLimit: null, pinnedUrl: "https://media.example.com",
}

function testFreshRoundTrip() {
  const y = generateComposeYaml(base)
  const p = parseComposeYaml(y)
  assert.deepEqual(p.services, ["jellyfin"])
  assert.deepEqual(p.app, base) // defaults resolve identically
  assert.deepEqual(p.unknownFields, [])
  assert.match(y, /container_name: jellyfin/)
  assert.match(y, /x-hsi:/)
}

function testUnknownFieldsAndCommentsSurviveEdit() {
  const existing = [
    "# Managed by HSI - editable by hand, re-read on load.",
    "services:",
    "  jellyfin:",
    "    image: jellyfin/jellyfin:10.0",
    "    # my comment",
    "    healthcheck:",
    "      test: [\"CMD\", \"curl\", \"-f\", \"localhost:8096\"]",
    "    container_name: jellyfin",
    "networks:",
    "  hsi-net:",
    "    external: true",
    "    name: hsi-net",
  ].join("\n")
  const y = generateComposeYaml({ ...base, image: "jellyfin/jellyfin:10.1" }, existing)
  assert.match(y, /jellyfin\/jellyfin:10\.1/) // updated image
  assert.match(y, /healthcheck:/)          // unknown key kept
  assert.match(y, /# my comment/)          // comments kept
  assert.match(y, /external: true/)        // pre-existing network kept
  const p = parseComposeYaml(y)
  assert.deepEqual(p.unknownFields, ["services.jellyfin.healthcheck"])
}

function testMultiServiceIsNotApp() {
  const y = generateComposeYaml(base).replace("container_name: jellyfin\n", "") +
    "\n  second:\n    image: busybox\n"
  const p = parseComposeYaml(y)
  assert.equal(p.app, null)
  assert.deepEqual(p.services.sort(), ["jellyfin", "second"])
}

function testPlaceVolumesRejected() {
  assert.throws(() => generateComposeYaml({ ...base, volumes: [{ type: "place", source: "place-id", target: "/media", readOnly: false }] }),
    /place volumes must be resolved/)
}

function testEmptyValuesDeleteKeys() {
  const y = generateComposeYaml({ ...base, restartPolicy: "no", networkNames: [], labels: [] })
  assert.doesNotMatch(y, /restart:/)
  assert.doesNotMatch(y, /networks:/)
}

function testStackNameRegex() {
  assert.match("jellyfin", STACK_NAME_RE)
  // Compose v2 lowercases project names, so mixed case can never match.
  assert.doesNotMatch("Jellyfin", STACK_NAME_RE)
  assert.doesNotMatch("../etc", STACK_NAME_RE)
  assert.doesNotMatch("-lead", STACK_NAME_RE)
  assert.doesNotMatch("a b", STACK_NAME_RE)
}

function testListFormEnvsAndLabelsRoundTrip() {
  const existing = [
    "services:",
    "  jellyfin:",
    "    image: jellyfin/jellyfin:latest",
    "    environment:",
    "      - TZ=Europe/Paris",
    "      - NO_PROXY=localhost,127.0.0.1",
    "    labels:",
    "      - hsi.catalog.id=jellyfin",
    "      - com.example.tag=media",
  ].join("\n")
  const p = parseComposeYaml(existing)
  assert.ok(p.app, "list-form environment/labels must parse to an app")
  assert.deepEqual(p.app.envs, [
    { key: "TZ", value: "Europe/Paris" },
    { key: "NO_PROXY", value: "localhost,127.0.0.1" },
  ])
  assert.deepEqual(p.app.labels, [
    { key: "hsi.catalog.id", value: "jellyfin" },
    { key: "com.example.tag", value: "media" },
  ])
  // Regenerate in place: the env/labels must survive as a map of the actual
  // values, not as mangled {"0": "TZ=..."} entries.
  const y = generateComposeYaml(p.app, existing)
  const p2 = parseComposeYaml(y)
  assert.deepEqual(p2.app?.envs, p.app.envs)
  assert.deepEqual(p2.app?.labels, p.app.labels)
  assert.match(y, /TZ: Europe\/Paris/)
  assert.match(y, /com\.example\.tag: media/)
}

function testListEntryWithoutEqualsDowngradesToRawOnly() {
  const y = "services:\n  jellyfin:\n    image: busybox\n    environment:\n      - BARE\n"
  const p = parseComposeYaml(y)
  assert.equal(p.app, null)
}

function testUnknownXhsiKeysSurviveRegenerate() {
  const existing = [
    "services:",
    "  jellyfin:",
    "    image: jellyfin/jellyfin:latest",
    "    x-hsi:",
    "      custom: keep",
    "      pinnedUrl: https://old.example.com",
  ].join("\n")
  const p = parseComposeYaml(existing)
  assert.ok(p.app, "x-hsi-only app must parse")
  assert.equal(p.app.pinnedUrl, "https://old.example.com")
  const y = generateComposeYaml({ ...p.app, pinnedUrl: "https://new.example.com" }, existing)
  assert.match(y, /pinnedUrl: https:\/\/new\.example\.com/) // model value wins
  assert.match(y, /custom: keep/)                           // unknown sub-key preserved
  const p2 = parseComposeYaml(y)
  assert.equal(p2.app?.pinnedUrl, "https://new.example.com")
}

testFreshRoundTrip()
testUnknownFieldsAndCommentsSurviveEdit()
testMultiServiceIsNotApp()
testPlaceVolumesRejected()
testEmptyValuesDeleteKeys()
testStackNameRegex()
testListFormEnvsAndLabelsRoundTrip()
testListEntryWithoutEqualsDowngradesToRawOnly()
testUnknownXhsiKeysSurviveRegenerate()

console.log("Compose package tests passed")
