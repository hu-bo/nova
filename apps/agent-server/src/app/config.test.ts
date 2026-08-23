import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const required = {
  DATABASE_URL: "postgres://test",
  AUTH_SERVICE_URL: "http://auth.example.com",
  MODEL_CONFIG_ENCRYPTION_KEY: "a".repeat(43),
};

describe("runner public endpoint configuration", () => {
  it("derives the public endpoint from the listening port", async () => {
    const app = Fastify();
    const config = await loadConfig(app, { ...required, RUNNER_HOST: "0.0.0.0", RUNNER_PORT: "50123" });

    expect(config.RUNNER_PUBLIC_URL).toBe("http://127.0.0.1:50123");
    await app.close();
  });

  it("keeps an explicit public endpoint for reverse proxies", async () => {
    const app = Fastify();
    const config = await loadConfig(app, {
      ...required,
      RUNNER_PORT: "50123",
      RUNNER_PUBLIC_URL: "https://runner.example.com",
    });

    expect(config.RUNNER_PUBLIC_URL).toBe("https://runner.example.com");
    await app.close();
  });
});
