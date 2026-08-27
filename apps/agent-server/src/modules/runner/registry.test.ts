import type { RunnerSession } from "@nova/runner-sdk";
import { describe, expect, it } from "vitest";
import { createRunnerRegistry } from "./registry.js";

describe("runner directory browsing", () => {
  it("lists owned directories from the runner root and rejects paths outside it", async () => {
    const root = "E:\\work";
    const mutableSession = {
      identity: { runnerId: "runner-1", workspace: root },
      generation: "generation-1",
      lastHeartbeatAt: Date.now(),
      state: 1,
      running: 0,
      onStatus: () => () => {},
      close: async () => {},
      fs: {
        stat: async () => ({ kind: 2 }),
        list: async () => [
          { name: "src", kind: 2 },
          { name: "README.md", kind: 1 },
          { name: "packages", kind: 2 },
        ],
      },
    };
    const session = mutableSession as unknown as RunnerSession;
    const registry = createRunnerRegistry();
    await registry.register("alice", "token-1", session);

    await expect(registry.listDirectories("alice", "runner-1")).resolves.toEqual({
      root,
      path: root,
      parent: null,
      directories: [
        { name: "packages", path: "E:\\work\\packages" },
        { name: "src", path: "E:\\work\\src" },
      ],
    });
    await expect(registry.listDirectories("alice", "runner-1", "E:\\outside")).rejects.toMatchObject({
      code: "RUNNER_UNAVAILABLE",
    });
  });
});

describe("runner registration lifecycle", () => {
  it("keeps an accepted session until its first heartbeat", async () => {
    let notify: (() => void) | undefined;
    const mutableSession: {
      lastHeartbeatAt: number | null;
      state: number;
      [key: string]: unknown;
    } = {
      identity: { runnerId: "runner-1", workspace: "E:\\work" },
      generation: "generation-1",
      connected: true,
      lastHeartbeatAt: null,
      state: 0,
      running: 0,
      onStatus: (listener: () => void) => {
        notify = listener;
        return () => {};
      },
      close: async () => {},
    };
    const session = mutableSession as unknown as RunnerSession;
    const registry = createRunnerRegistry();

    await registry.register("alice", "token-1", session);
    expect(registry.status("alice", "runner-1")).toBe("disconnected");

    mutableSession.lastHeartbeatAt = Date.now();
    mutableSession.state = 1;
    notify?.();
    expect(registry.status("alice", "runner-1")).toBe("ready");
  });
});
