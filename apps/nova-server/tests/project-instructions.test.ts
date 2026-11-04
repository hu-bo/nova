import assert from "node:assert/strict";
import test from "node:test";
import type { ToolContext } from "@nova/runner-sdk";
import { resolveProjectInstructions } from "../src/modules/runs/project-instructions.js";
import { bindProjectBodySchema } from "../src/modules/projects/project-binding.schema.js";

test("project instructions select only the configured source and preserve legacy prompts", async () => {
  const signal = new AbortController().signal;
  const noRead = async (): Promise<ToolContext> => {
    throw new Error("Unexpected workspace read");
  };
  assert.equal(await resolveProjectInstructions(undefined, noRead, signal), "");
  assert.equal(await resolveProjectInstructions({ customPrompt: "legacy" }, noRead, signal), "legacy");
  assert.equal(await resolveProjectInstructions({ source: "none", customPrompt: "ignored" }, noRead, signal), "");
  assert.equal(
    await resolveProjectInstructions({ source: "custom", customPrompt: "custom" }, noRead, signal),
    "custom",
  );
  for (const [source, filename] of [
    ["agents", "AGENTS.md"],
    ["claude", "CLAUDE.md"],
  ] as const) {
    const context = {
      fs: {
        read: async (path: string, options: { signal: AbortSignal; limit: number }) => {
          assert.equal(path, filename);
          assert.equal(options.signal, signal);
          assert.equal(options.limit, 2000);
          return { ok: true, value: { text: "workspace instructions", truncated: false, lineTruncated: false } };
        },
      },
    } as unknown as ToolContext;
    assert.equal(
      await resolveProjectInstructions({ source, customPrompt: "ignored" }, async () => context, signal),
      "workspace instructions",
    );
  }
});

test("project instruction read failures, truncation, size limits and cancellation stop the run", async () => {
  for (const result of [
    { ok: false, error: { code: "NOT_FOUND", message: "sensitive error" } },
    { ok: true, value: { text: "partial", truncated: true } },
    { ok: true, value: { text: "partial", lineTruncated: true } },
    { ok: true, value: { text: "a".repeat(32001) } },
  ]) {
    const context = { fs: { read: async () => result } } as unknown as ToolContext;
    await assert.rejects(
      resolveProjectInstructions({ source: "agents" }, async () => context, new AbortController().signal),
      { code: "CONFLICT" },
    );
  }
  const controller = new AbortController();
  const context = {
    fs: {
      read: async () => {
        controller.abort();
        return { ok: true, value: { text: "content" } };
      },
    },
  } as unknown as ToolContext;
  await assert.rejects(
    resolveProjectInstructions({ source: "claude" }, async () => context, controller.signal),
    { name: "AbortError" },
  );
});

test("binding contract supports all instruction sources and rejects unknown values", () => {
  const input = {
    runnerId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "workspace",
    canonicalCwd: ".",
    expectedRevision: 0,
  };
  for (const source of ["agents", "claude", "custom", "none"]) {
    assert.equal(bindProjectBodySchema.parse({ ...input, instructionSource: source }).instructionSource, source);
  }
  assert.equal(bindProjectBodySchema.parse(input).instructionSource, undefined);
  assert.equal(bindProjectBodySchema.safeParse({ ...input, instructionSource: "arbitrary-file" }).success, false);
});
