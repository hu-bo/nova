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
};

const DAY_MS = 24 * 60 * 60 * 1000;

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
 * Writes pino's JSON lines to a size/time rotating file, one record per line.
 *
 * Replaces `pino-transport-rotating-file`, whose raw mode concatenated records without line
 * separators (invalid NDJSON) and whose only JSON-free alternative was hardcoded pino-pretty.
 */
export default function rotatingFileTransport(options: RotatingFileTransportOptions) {
  const { dir, filename = "app", size = "20M", interval = "1d", retentionDays = 30 } = options;
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

  return build(
    async (source) => {
      for await (const line of source) {
        if (!failed) fileStream.write(`${line}\n`);
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
