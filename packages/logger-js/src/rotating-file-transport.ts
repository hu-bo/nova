import build from "pino-abstract-transport";
import fs from "node:fs";
import path from "node:path";
import { createStream, type RotatingFileStream } from "rotating-file-stream";

export type RotatingFileTransportOptions = {
  dir: string;
  filename?: string;
  size?: string;
  interval?: string;
  retentionDays?: number;
  /** Record keys omitted from the per-line JSON suffix (per-process base bindings). */
  ignore?: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

const LEVEL_NAMES: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

// Keys consumed by the `TIME LEVEL [service] message` prefix or never useful on every line.
const ENVELOPE_KEYS = new Set(["level", "time", "msg", "service", "pid", "hostname", "err"]);

/** Renders one pino JSON line as `TIME LEVEL [service] message {extras}`; error stacks follow on their own lines. */
function formatRecord(line: string, defaultService: string, ignored: Set<string>): string {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line; // Anything pino did not write as JSON is kept verbatim instead of dropped.
  }
  const level = LEVEL_NAMES[Number(record.level)] ?? String(record.level ?? "LOG");
  const time = typeof record.time === "string" && record.time !== "" ? record.time : new Date().toISOString();
  const service = typeof record.service === "string" && record.service !== "" ? record.service : defaultService;
  const parts = [time, level.padEnd(5), `[${service}]`];
  if (typeof record.msg === "string" && record.msg !== "") parts.push(record.msg);
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!ENVELOPE_KEYS.has(key) && !ignored.has(key)) extras[key] = value;
  }
  if (Object.keys(extras).length > 0) parts.push(JSON.stringify(extras));
  const head = parts.join(" ");
  const err = record.err;
  if (typeof err !== "object" || err === null) return head;
  const fields = err as { stack?: unknown; message?: unknown };
  if (typeof fields.stack === "string") return `${head}\n${fields.stack}`;
  if (typeof fields.message === "string") return `${head}\n${fields.message}`;
  return `${head}\n${JSON.stringify(err)}`;
}

// Rotated names keep the creation-time UTC timestamp, matching the previous transport's `iso` format
// (app-YYYYMMDDHHMMSS.log). rfs starts the per-period index at 1, so only suffix it on collisions.
function rotatedFileName(base: string, time?: number | Date | null, index?: number | null): string {
  if (!time) return `${base}.log`;
  const stamp = new Date(time).toISOString().replace(/[-:T]/g, "").split(".")[0];
  const suffix = index == null || index <= 1 ? "" : `-${index}`;
  return `${base}-${stamp}${suffix}.log`;
}

function cleanupExpiredLogs(dir: string, prefix: string, retentionDays: number): void {
  if (retentionDays <= 0) return;
  const deadline = Date.now() - retentionDays * DAY_MS;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(`${prefix}-`) || !(name.endsWith(".log") || name.endsWith(".log.gz"))) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < deadline) fs.rmSync(file);
    } catch {
      // The file may have just been rotated or removed; the next cleanup pass covers it.
    }
  }
}

/**
 * Writes pino records as human-readable rotating text lines, one record per line (plus stack lines).
 * Container stdout keeps the JSON records; this file exists so operators can read `LOG_DIR` directly.
 *
 * Replaces `pino-transport-rotating-file`, whose raw mode concatenated records without line
 * separators (invalid NDJSON) and whose only JSON-free alternative was hardcoded pino-pretty.
 */
export default function rotatingFileTransport(options: RotatingFileTransportOptions) {
  const {
    dir,
    filename = "app",
    size = "20M",
    interval = "1d",
    retentionDays = 30,
    ignore = [],
  } = options;
  fs.mkdirSync(dir, { recursive: true });

  // immutable: every file keeps its creation timestamp name, so the active file never changes name.
  const fileStream: RotatingFileStream = createStream(
    (time, index) => rotatedFileName(filename, time, index),
    { path: dir, interval, size, immutable: true },
  );
  let failed = false;
  fileStream.on("error", (error: Error) => {
    // Logging must not crash the worker when the volume fails; pino forwards worker stderr to the main process.
    failed = true;
    console.error(`[logger-js] rotating file stream for ${dir} failed:`, error?.message ?? error);
  });

  const cleanup = () => {
    try {
      cleanupExpiredLogs(dir, filename, retentionDays);
    } catch (error) {
      console.error(`[logger-js] log retention cleanup for ${dir} failed:`, (error as Error)?.message ?? error);
    }
  };
  cleanup();
  setInterval(cleanup, DAY_MS).unref();

  const ignored = new Set(ignore);
  return build(
    async (source) => {
      for await (const line of source) {
        if (!failed) fileStream.write(`${formatRecord(line, filename, ignored)}\n`);
      }
      if (!failed) {
        await new Promise<void>((resolve, reject) => {
          fileStream.once("close", resolve);
          fileStream.once("error", reject);
          fileStream.end();
        });
      }
    },
    { parse: "lines" },
  );
}
