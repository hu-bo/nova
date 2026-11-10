import { createLogger } from "@hquant/logger-js";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";

function localTimestamp(): string {
  const now = new Date(Date.now());
  const offsetMinutes = -now.getTimezoneOffset();
  const local = new Date(now.getTime() + offsetMinutes * 60_000).toISOString().slice(0, -1);
  const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  return `,"time":"${local}${offsetMinutes >= 0 ? "+" : "-"}${hours}:${minutes}"`;
}

export function createLoggerOptions(level: AppConfig["LOG_LEVEL"]) {
  return {
    level,
    timestamp: localTimestamp,
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
