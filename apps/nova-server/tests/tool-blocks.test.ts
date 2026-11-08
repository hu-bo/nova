import assert from "node:assert/strict";
import test from "node:test";
import { applyEvent, outputTail, snapshotSchema, type Message, type ProductEvent } from "@nova/agent-ui-contracts";
import { createRemoteTools } from "@nova/tools/harness";
import { chatEventOutput, chatMessageOutput, chatSnapshotOutput } from "../src/modules/chat-tool-output.js";
import { projectToolContent } from "../src/modules/runs/tool-blocks.js";

test("Spec chat summaries omit internal revision data and do not claim a candidate was saved", () => {
  assert.deepEqual(projectToolContent("spec_update", { baseRevision: 3, stage: "requirements", content: "# draft" }),
    [{ id: "content", type: "text", text: "已提交规格草稿，运行完成后校验并保存。" }]);
  assert.deepEqual(projectToolContent("spec_read", { revision: 3 }),
    [{ id: "content", type: "text", text: "已读取当前规格，继续讨论需求与方案。" }]);
});

test("unwraps the success envelope to its content text", () => {
  const blocks = projectToolContent("list_dir", {
    status: "ok",
    content: "Cargo.toml\nREADME.md",
    details: { path: ".", entries: [{ path: "Cargo.toml", kind: "file", sizeBytes: 980 }] },
  });
  assert.deepEqual(blocks, [{ id: "content", type: "text", text: "Cargo.toml\nREADME.md" }]);
});

test("projects read_file details as a code block", () => {
  const blocks = projectToolContent("read_file", {
    status: "ok",
    content: "1: # demo",
    details: { path: "README.md", text: "# demo", startLine: 1 },
  });
  assert.deepEqual(blocks, [{ id: "content", type: "code", language: "markdown", code: "# demo", path: "README.md" }]);
});

test("projects successful file writes with the original hunk line numbers", async () => {
  const before =
    Array.from({ length: 30 }, (_, index) => (index === 12 || index === 26 ? "old" : `line ${index + 1}`)).join("\n") +
    "\n";
  let file = before;
  const signal = new AbortController().signal;
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected filesystem call");
  };
  const tools = createRemoteTools({
    createContext: async () => ({
      cwd: ".",
      signal,
      exec: unused,
      fs: {
        readBytes: unused,
        list: unused,
        grep: unused,
        read: async () => ({
          ok: true,
          value: {
            text: file,
            startLine: 1,
            endLine: 30,
            totalSize: file.length,
            sha256: "before",
            truncated: false,
            lineTruncated: false,
          },
        }),
        patch: async (path, edits, options) => {
          assert.equal(options.expectedSha256, "before");
          for (const edit of edits) file = file.replace(edit.oldText, () => edit.newText);
          return { ok: true, value: { path, sha256: "after", sizeBytes: file.length, editCount: edits.length } };
        },
        write: async (path, content) => {
          file = content;
          return { ok: true, value: { path, sha256: "after", sizeBytes: file.length, created: false } };
        },
      },
    }),
  });
  const context = {
    signal,
    namespace: "test",
    identity: {},
    sessionId: "session",
    runId: "run",
    executionId: "execution",
    callId: "call",
    idempotencyKey: "test",
  };
  const path = "src/demo.ts";
  const execute = async (name: string, args: object) => {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool);
    return projectToolContent(name, await tool.execute({ path, ...args }, context));
  };
  const [edit] = await execute("edit_file", { oldText: "old", newText: "$& changed", replaceAll: true });
  assert.ok(edit?.type === "diff");
  assert.equal(edit.path, path);
  assert.match(edit.diff, /@@ -10,7 \+10,7 @@/);
  assert.match(edit.diff, /@@ -24,7 \+24,7 @@/);
  assert.match(edit.diff, /\+\$& changed/);
  assert.equal(
    file,
    before.replaceAll("old", () => "$& changed"),
  );
  const [write] = await execute("write_file", { content: before });
  assert.ok(write?.type === "diff");
  assert.match(write.diff, /-\$& changed\n\+old/);
  const [noChange] = await execute("write_file", { content: before });
  assert.equal(noChange?.type, "text");
  const [oversized] = await execute("write_file", { content: "x".repeat(13_000) });
  assert.ok(oversized?.type === "text");
  assert.match(oversized.text, /文件改动过大/);
});

test("splits bash stdout and stderr into code and error blocks", () => {
  const blocks = projectToolContent("bash", {
    status: "error",
    content: "out\nerr",
    details: { exitCode: 1, stdout: "out", stderr: "err" },
  });
  assert.deepEqual(blocks, [
    { id: "content:stdout", type: "code", language: "text", code: "out" },
    { id: "content:stderr", type: "error", error: { code: "STDERR", message: "err" } },
  ]);
});

test("projects runtime failures as error blocks", () => {
  const blocks = projectToolContent("read_file", {
    error: { code: "NOT_FOUND", message: "File not found" },
    outcome: "known",
  });
  assert.deepEqual(blocks, [{ id: "content", type: "error", error: { code: "NOT_FOUND", message: "File not found" } }]);
});

test("truncates oversized output", () => {
  const blocks = projectToolContent("grep", { status: "ok", content: "x".repeat(20_000), details: null });
  const [block] = blocks;
  assert.ok(block?.type === "text");
  assert.ok(block.text.length < 20_000);
  assert.match(block.text, /… 已省略 8000 个字符$/);
});

test("falls back to JSON text for custom outputs", () => {
  const blocks = projectToolContent("inspect", { done: true });
  assert.deepEqual(blocks, [{ id: "content", type: "text", text: '{\n  "done": true\n}' }]);
});

test("bounds legacy tool results and removes output while preserving call identity and outcome", () => {
  const result = {
    id: "result",
    type: "tool_result",
    callId: "call",
    operationId: "operation",
    outcome: "failed",
    content: [{ id: "content", type: "text", text: "大".repeat(40_000) + "omitted" }],
  } as const;
  const message: Message = {
    id: "message",
    runId: "run",
    sequence: "1",
    role: "tool",
    state: "completed",
    createdAt: "2026-01-01T00:00:00Z",
    blocks: [{ ...result, content: [...result.content] }],
  };
  const event: ProductEvent = { type: "message.committed", sequence: "2", runId: "run", payload: { message } };
  const bounded = chatMessageOutput(message, true);
  assert.match(JSON.stringify(bounded), /工具结果已截断/);
  assert.doesNotMatch(JSON.stringify(bounded), /omitted/);
  assert.deepEqual(chatEventOutput(event, false), {
    ...event,
    payload: { message: { ...message, blocks: [{ ...result, content: [] }] } },
  });
  assert.match(JSON.stringify(message), /omitted/);
});

test("bounded snapshots and live tool output use the same offsets", () => {
  const text = "中".repeat(9000);
  const snapshot = snapshotSchema.parse({
    conversation: { id: "chat", title: null, mode: "chat", projectId: null, epoch: 1, configuration: {} },
    cursor: "1",
    messages: [],
    beforeSequence: null,
    run: null,
    operations: [{ id: "op", callId: "call", state: "running", stdout: outputTail(text, text.length) }],
    pendingInputs: [],
    interactions: [],
    capabilities: {
      tools: true,
      approval: false,
      question: false,
      steering: false,
      resume: false,
      compact: false,
      images: false,
      files: false,
    },
  });
  const delta = (sequence: string, offset: number, value: string): ProductEvent => ({
    type: "tool.output",
    runId: "run",
    sequence,
    payload: { operationId: "op", channel: "stdout", offset, text: value },
  });
  for (const include of [true, false]) {
    let view = snapshotSchema.parse(chatSnapshotOutput(snapshot, include));
    view = applyEvent(view, chatEventOutput(delta("2", 9000, "x".repeat(5000)), include));
    view = applyEvent(view, chatEventOutput(delta("3", 14000, "omitted"), include));
    assert.equal(view.cursor, "3");
    assert.equal(view.operations[0]?.stdout?.text, include ? text + "x".repeat(1000) : "");
  }
});
