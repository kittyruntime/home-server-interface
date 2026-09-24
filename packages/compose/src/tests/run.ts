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
  assert.doesNotMatch("../etc", STACK_NAME_RE)
  assert.doesNotMatch("-lead", STACK_NAME_RE)
  assert.doesNotMatch("a b", STACK_NAME_RE)
}

testFreshRoundTrip()
testUnknownFieldsAndCommentsSurviveEdit()
testMultiServiceIsNotApp()
testPlaceVolumesRejected()
testEmptyValuesDeleteKeys()
testStackNameRegex()

console.log("Compose package tests passed")
