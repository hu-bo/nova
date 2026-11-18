import { createLogger } from "@hquant/logger-js";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";

// China has no daylight saving, so a fixed +08:00 offset is exact. Production containers run in UTC,
// so deriving from the host timezone would print the wrong wall-clock time.
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function shanghaiTimestamp(): string {
  const now = new Date(Date.now() + SHANGHAI_OFFSET_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  const clock = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
  return `,"time":"${date} ${clock}"`;
}

export function createLoggerOptions(level: AppConfig["LOG_LEVEL"]) {
  return {
    level,
    timestamp: shanghaiTimestamp,
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.password",
      "req.body.token",
      "req.body.credential",
      "req.body.passphrase",
    ],
  };
}

export function createAppLogger(
  config: Pick<AppConfig, "LOG_LEVEL" | "NODE_ENV" | "LOG_DIR" | "ROLE">,
): FastifyBaseLogger {
  return createLogger("nova-server", {
    ...createLoggerOptions(config.LOG_LEVEL),
    environment: config.NODE_ENV,
    directory: config.LOG_DIR,
    base: { role: config.ROLE, nodeVersion: process.version, platform: process.platform },
  });
}
