import { describe, expect, it } from "vitest";
import { createRunnerSdk } from "../src/server.js";

describe("RunnerSdk listener lifecycle", () => {
  it("shares one listener across concurrent listen calls", async () => {
    const sdk = createRunnerSdk();

    await Promise.all([sdk.listen(), sdk.listen(), sdk.listen()]);

    expect(sdk.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await sdk.close();
    expect(sdk.endpoint).toBe("");
  });

  it("can listen again after close", async () => {
    const sdk = createRunnerSdk();

    await sdk.listen();
    await sdk.close();
    await sdk.listen();

    expect(sdk.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await sdk.close();
  });

  it("waits for a starting listener before closing it", async () => {
    const sdk = createRunnerSdk();

    await Promise.all([sdk.listen(), sdk.close()]);

    expect(sdk.endpoint).toBe("");
  });

  it("allows one session admission owner", () => {
    const sdk = createRunnerSdk();
    const unsubscribe = sdk.onSession(() => {});

    expect(() => sdk.onSession(() => {})).toThrow("already registered");
    unsubscribe();
    expect(() => sdk.onSession(() => {})).not.toThrow();
  });

  it("rejects an invalid admission timeout at construction", () => {
    expect(() => createRunnerSdk({ admissionTimeoutMs: 0 })).toThrow(RangeError);
  });
});
