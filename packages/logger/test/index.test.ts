import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { createLogger } from "../src/index.js";

function readLog(stream: PassThrough): Record<string, unknown> {
  const line = stream.read()?.toString();
  if (!line) {
    throw new Error("expected a log line");
  }

  return JSON.parse(line) as Record<string, unknown>;
}

describe("createLogger", () => {
  it("writes service and structured fields", () => {
    const stream = new PassThrough();
    const logger = createLogger("trader-service", { stream });

    logger.warn({ symbol: "BTC-USDT" }, "price spike");

    expect(readLog(stream)).toMatchObject({
      service: "trader-service",
      level: "warn",
      symbol: "BTC-USDT",
      msg: "price spike",
    });
  });

  it("adds scope to child loggers", () => {
    const stream = new PassThrough();
    const logger = createLogger("trader-service", { stream });

    logger.child("api").info({ path: "/health" }, "request");

    expect(readLog(stream)).toMatchObject({
      service: "trader-service",
      scope: "api",
      path: "/health",
      msg: "request",
    });
  });

  it("serializes errors", () => {
    const stream = new PassThrough();
    const logger = createLogger("trader-service", { stream });

    logger.error(new Error("boom"), "unexpected error");

    expect(readLog(stream)).toMatchObject({
      err: { type: "Error", message: "boom" },
      msg: "unexpected error",
    });
  });
});
