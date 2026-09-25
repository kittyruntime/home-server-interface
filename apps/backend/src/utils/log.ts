import os from "node:os"
import type { FastifyBaseLogger, FastifyServerOptions } from "fastify"

// One JSON log format for the backend and the root worker (see
// docs/configuration.md#logs): ISO `time`, lowercase `level` name, `msg`, and
// `component`. Fastify's pino logger is configured with these options; code
// outside request handlers (services, samplers) logs through `log` below, which
// forwards to the same logger once the app is built.
export const loggerOptions: FastifyServerOptions["logger"] = {
  base: { component: "backend", pid: process.pid, hostname: os.hostname() },
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
  formatters: { level: (label: string) => ({ level: label }) },
}

type Level = "debug" | "info" | "warn" | "error" | "fatal"

let current: FastifyBaseLogger | null = null

/** Called by buildApp() with the Fastify logger. */
export function setLogger(logger: FastifyBaseLogger): void {
  current = logger
}

// Before the app exists (module init, JWT checks), write the same shape by hand.
function fallback(level: Level, obj: Record<string, unknown>, msg: string): void {
  const err = obj.err instanceof Error ? { err: { message: obj.err.message, stack: obj.err.stack } } : {}
  process.stderr.write(JSON.stringify({
    level, time: new Date().toISOString(), component: "backend", pid: process.pid, hostname: os.hostname(),
    ...obj, ...err, msg,
  }) + "\n")
}

function write(level: Level, objOrMsg: Record<string, unknown> | string, msg?: string): void {
  const obj = typeof objOrMsg === "string" ? {} : objOrMsg
  const text = typeof objOrMsg === "string" ? objOrMsg : (msg ?? "")
  if (current) current[level](obj, text)
  else fallback(level, obj, text)
}

/** Shared backend logger. Pass errors as `{ err }` so they are serialised. */
export const log = {
  debug: (objOrMsg: Record<string, unknown> | string, msg?: string) => write("debug", objOrMsg, msg),
  info:  (objOrMsg: Record<string, unknown> | string, msg?: string) => write("info", objOrMsg, msg),
  warn:  (objOrMsg: Record<string, unknown> | string, msg?: string) => write("warn", objOrMsg, msg),
  error: (objOrMsg: Record<string, unknown> | string, msg?: string) => write("error", objOrMsg, msg),
  fatal: (objOrMsg: Record<string, unknown> | string, msg?: string) => write("fatal", objOrMsg, msg),
}
