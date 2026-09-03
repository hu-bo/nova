import { RunnerError, type RunnerSession } from "@nova/runner-sdk";
import { describe, expect, it, vi } from "vitest";
import { createRunnerRegistry } from "./registry.js";

describe("runner file browsing", () => {
  it("reports the selected-workspace error when a project path is outside the runner root", async () => {
    const session = {
      identity: { runnerId: "runner-1", workspace: "E:\\work" },
      generation: "generation-1",
      lastHeartbeatAt: Date.now(),
      state: 1,
      running: 0,
      onStatus: () => () => {},
      close: async () => {},
      fs: { stat: async () => ({ kind: 2, size: 0n }) },
    } as unknown as RunnerSession;
    const registry = createRunnerRegistry();
    await registry.register("alice", "token-1", session);

    await expect(registry.verifyWorkspace("alice", "runner-1", "E:\\other")).rejects.toMatchObject({
      code: "RUNNER_UNAVAILABLE",
      message: "Runner cannot access the selected workspace",
    });
  });

  it("lists owned files and directories from the runner root and rejects paths outside it", async () => {
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
        stat: async () => ({ kind: 2, size: 0n }),
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
      entries: [
        { name: "packages", path: "E:\\work\\packages", kind: "directory" },
        { name: "src", path: "E:\\work\\src", kind: "directory" },
        { name: "README.md", path: "E:\\work\\README.md", kind: "file" },
      ],
    });
    await expect(registry.listDirectories("alice", "runner-1", "E:\\outside")).rejects.toMatchObject({
      code: "RUNNER_UNAVAILABLE",
    });
  });

  it("reads only an owned regular file within the configured size limit", async () => {
    const stat = vi.fn(async () => ({ kind: 1, size: 5n }));
    const readFile = vi.fn(async () => ({ data: new TextEncoder().encode("hello"), totalSize: 5 }));
    const session = {
      identity: { runnerId: "runner-1", workspace: "/workspace" },
      generation: "generation-1",
      lastHeartbeatAt: Date.now(),
      state: 1,
      running: 0,
      onStatus: () => () => {},
      close: async () => {},
      fs: { stat, readFile },
    } as unknown as RunnerSession;
    const registry = createRunnerRegistry();
    await registry.register("alice", "token-1", session);

    await expect(registry.readFile("alice", "runner-1", "/workspace/note.txt", 20)).resolves.toEqual({
      name: "note.txt",
      size: 5,
      data: new TextEncoder().encode("hello"),
    });
    expect(readFile).toHaveBeenCalledWith("/workspace/note.txt", { limit: 21 });

    await expect(registry.readFile("bob", "runner-1", "/workspace/note.txt", 20)).rejects.toMatchObject({
      code: "RUNNER_UNAVAILABLE",
    });
    await expect(registry.readFile("alice", "runner-1", "/outside/secret.txt", 20)).rejects.toMatchObject({
      code: "RUNNER_UNAVAILABLE",
    });

    stat.mockResolvedValueOnce({ kind: 2, size: 0n });
    await expect(registry.readFile("alice", "runner-1", "/workspace/src", 20)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    stat.mockResolvedValueOnce({ kind: 1, size: 21n });
    await expect(registry.readFile("alice", "runner-1", "/workspace/large.bin", 20)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects a file whose canonical path escapes the project workspace", async () => {
    const session = {
      identity: { runnerId: "runner-1", workspace: "/workspace" },
      generation: "generation-1",
      lastHeartbeatAt: Date.now(),
      state: 1,
      running: 0,
      onStatus: () => () => {},
      close: async () => {},
      fs: {
        stat: async (selected: string) =>
          selected === "/workspace/project"
            ? { path: "project", kind: 2, size: 0n }
            : { path: "other/AGENTS.md", kind: 1, size: 5n },
        readFile: async () => ({ data: new TextEncoder().encode("rules"), totalSize: 5 }),
      },
    } as unknown as RunnerSession;
    const registry = createRunnerRegistry();
    await registry.register("alice", "token-1", session);

    await expect(
      registry.readFile("alice", "runner-1", "/workspace/project/link/AGENTS.md", 20, "/workspace/project"),
    ).rejects.toMatchObject({ code: "RUNNER_UNAVAILABLE", message: "The selected file escapes the project workspace" });
  });

  it("treats a missing optional file as an empty probe result", async () => {
    const session = {
      identity: { runnerId: "runner-1", workspace: "/workspace" },
      generation: "generation-1",
      lastHeartbeatAt: Date.now(),
      state: 1,
      running: 0,
      onStatus: () => () => {},
      close: async () => {},
      fs: { stat: async () => Promise.reject(new RunnerError("NOT_FOUND", "missing")) },
    } as unknown as RunnerSession;
    const registry = createRunnerRegistry();
    await registry.register("alice", "token-1", session);

    await expect(
      registry.readFileIfExists("alice", "runner-1", "/workspace/AGENTS.md", 20, "/workspace"),
    ).resolves.toBeNull();
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
