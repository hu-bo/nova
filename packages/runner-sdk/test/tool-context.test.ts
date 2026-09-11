import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
  ExecuteRequestSchema,
  ExecutionStatus,
  GrepResultSchema,
  ReadTextResultSchema,
} from "../src/gen/execution_pb.js";
import { RegisterSchema, RunnerState } from "../src/gen/runner_pb.js";
import type { ExecuteRequest, ExecutionEvent } from "../src/gen/execution_pb.js";
import { BoundedQueue, RunnerSessionImpl, type RunnerSession, type ServerEnvelopeInit } from "../src/session.js";
import { toToolContext } from "../src/tool-context.js";

describe("toToolContext", () => {
  it("resolves Windows file paths from cwd without restricting parent reads", async () => {
    const readText = vi.fn(async () =>
      create(ReadTextResultSchema, {
        text: "source\n",
        startLine: 2n,
        endLine: 2n,
        totalLines: 2n,
        totalSize: 12n,
        truncated: false,
        lineTruncated: false,
      }),
    );
    const grep = vi.fn(async () =>
      create(GrepResultSchema, {
        matches: [{ file: "project/src/main.ts", line: 2, text: "source" }],
        total: 1,
        truncated: false,
      }),
    );
    const session = fakeSession("windows-x86_64", "E:\\work", { readText, grep });
    const context = toToolContext(session, { cwd: "E:\\work\\project" });

    const read = await context.fs.read("..\\shared\\config.ts", { offset: 2, limit: 1 });
    const searched = await context.fs.grep("source");

    expect(read.ok).toBe(true);
    expect(readText).toHaveBeenCalledWith("E:\\work\\shared\\config.ts", {
      offset: 2,
      limit: 1,
      maxBytes: 1024 * 1024,
    });
    expect(grep).toHaveBeenCalledWith("source", { path: "E:\\work\\project" });
    expect(searched).toEqual({
      ok: true,
      value: {
        matches: [{ file: "src\\main.ts", line: 2, text: "source" }],
        total: 1,
        truncated: false,
      },
    });
  });

  it("uses cwd as the default command directory", async () => {
    const requests: ExecuteRequest[] = [];
    const session = fakeSession("linux-x86_64", "/work", {
      execute: async function* (request: ExecuteRequest): AsyncIterable<ExecutionEvent> {
        requests.push(request);
        yield {
          event: {
            case: "finished",
            value: { status: ExecutionStatus.COMPLETED, exitCode: 0, durationMs: 1n },
          },
        } as ExecutionEvent;
      },
    });
    const context = toToolContext(session, { cwd: "/work/project" });

    await context.exec("git");
    await context.exec("git", { cwd: "../shared" });

    expect(requests.map((request) => request.cwd)).toEqual(["/work/project", "/work/shared"]);
  });

  it("settles when cancellation receives no Finished event", async () => {
    const controller = new AbortController();
    const outbound = new BoundedQueue<ServerEnvelopeInit>(8);
    const session = new RunnerSessionImpl(
      create(RegisterSchema, { runnerId: "runner", platform: "linux-x86_64", workspace: "/work" }),
      "generation",
      outbound,
    );
    const request = create(ExecuteRequestSchema, {
      executionId: "execution-cancelled",
      command: "git",
      args: ["config", "--file", ".gitmodules", "--list"],
      cwd: "/work",
    });
    const next = session.execute(request, controller.signal)[Symbol.asyncIterator]().next();
    await outbound.shift();
    controller.abort();
    await expect(next).rejects.toMatchObject({ code: "CANCELLED", message: "execution cancelled before Finished" });
  });
});

function fakeSession(
  platform: string,
  workspace: string,
  overrides: Partial<RunnerSession["fs"]> & { execute?: RunnerSession["execute"] },
): RunnerSession {
  const { execute, ...fsOverrides } = overrides;
  const unavailable = async () => {
    throw new Error("unused");
  };
  return {
    identity: create(RegisterSchema, { platform, workspace }),
    generation: "test",
    connected: true,
    lastHeartbeatAt: null,
    state: RunnerState.READY,
    running: 0,
    onStatus: () => () => {},
    execute: execute ?? async function* () {},
    cancel: async () => {},
    fs: {
      stat: unavailable,
      list: unavailable,
      remove: unavailable,
      rename: unavailable,
      mkdir: unavailable,
      tempDir: unavailable,
      grep: unavailable,
      readText: unavailable,
      readFile: unavailable,
      writeFile: unavailable,
      ...fsOverrides,
    } as RunnerSession["fs"],
    close: async () => {},
  } as unknown as RunnerSession;
}
