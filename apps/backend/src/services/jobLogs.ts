import { open } from "node:fs/promises"
import { join } from "node:path"

// Reads the log lines of one async job from the backend and worker log files,
// so an admin can see why an operation failed without a shell. Both files use
// the shared JSON format (docs/configuration.md#logs) and carry the `jobId`.

export const LOG_DIR = process.env.HSI_LOG_DIR ?? "/var/log/hsi"

const LOG_FILES = [
  { source: "backend", file: "app.log" },
  { source: "worker",  file: "root-worker.log" },
] as const

// Only the end of each file is scanned: a failed job is inspected right after
// it fails, and older lines are rotated away anyway.
const TAIL_BYTES = 8 * 1024 * 1024
const MAX_LINES = 200

// Fields already shown as columns, or noise for this view.
const HIDDEN_FIELDS = new Set(["time", "level", "msg", "component", "pid", "hostname", "jobId"])

export interface JobLogLine {
  source: "backend" | "worker"
  time:   string | null
  level:  string
  msg:    string
  fields: Record<string, unknown>
}

async function readTail(path: string, bytes: number): Promise<string> {
  let fh
  try {
    fh = await open(path, "r")
  } catch {
    return ""
  }
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    const text = buf.toString("utf8")
    // Drop the partial first line when reading from the middle of the file.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text
  } finally {
    await fh.close()
  }
}

function parseLine(source: JobLogLine["source"], raw: string): JobLogLine {
  try {
    const rec = JSON.parse(raw) as Record<string, unknown>
    const fields: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rec)) if (!HIDDEN_FIELDS.has(k)) fields[k] = v
    return {
      source,
      time:  typeof rec.time === "string" ? rec.time : null,
      level: typeof rec.level === "string" ? rec.level : "info",
      msg:   typeof rec.msg === "string" ? rec.msg : "",
      fields,
    }
  } catch {
    // Plain-text output that bypassed the logger (see docs).
    return { source, time: null, level: "info", msg: raw, fields: {} }
  }
}

export async function readJobLogs(jobId: string, dir = LOG_DIR): Promise<JobLogLine[]> {
  const lines: JobLogLine[] = []
  for (const { source, file } of LOG_FILES) {
    const text = await readTail(join(dir, file), TAIL_BYTES)
    for (const raw of text.split("\n")) {
      if (raw.includes(jobId)) lines.push(parseLine(source, raw))
    }
  }
  // Compare as instants: the worker writes local time with an offset, the
  // backend UTC. Lines without a time sort first.
  const at = (l: JobLogLine) => (l.time ? Date.parse(l.time) : NaN) || 0
  lines.sort((a, b) => at(a) - at(b))
  return lines.slice(-MAX_LINES)
}
