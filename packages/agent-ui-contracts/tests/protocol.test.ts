import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEvent,
  decimalSequenceSchema,
  fileRefSchema,
  inputBlocksSchema,
  interactionSchema,
  messageSchema,
  outputTail,
  productEventSchema,
  snapshotSchema,
  validInteractionResponse,
  type ProductEvent,
  type Snapshot,
} from "../src/index.js";

test("SSH attachments accept absolute paths while Runner attachments remain workspace-relative", () => {
  const ssh = { kind: "ssh", remoteConnectionId: "remote-1" };
  const runner = { kind: "runner", runnerId: "runner-1", workspaceId: "workspace-1" };
  for (const path of ["/etc/config.txt", "/var/log/app.log", "notes.txt"]) {
    assert.ok(fileRefSchema.safeParse({ ...ssh, path }).success);
  }
  assert.ok(fileRefSchema.safeParse({ ...runner, path: "notes.txt" }).success);
  assert.equal(fileRefSchema.safeParse({ ...runner, path: "/etc/config.txt" }).success, false);
  for (const path of ["../etc/config.txt", "/etc/\0config", "C:/config.txt"]) {
    assert.equal(fileRefSchema.safeParse({ ...ssh, path }).success, false);
    assert.equal(fileRefSchema.safeParse({ ...runner, path }).success, false);
  }
});

const capabilities = {
  tools: true,
  approval: true,
  question: true,
  steering: true,
  resume: true,
  compact: false,
  images: false,
  files: true,
};
const initial: Snapshot = {
  conversation: {
    id: "conversation",
    title: null,
    mode: "chat",
    projectId: null,
    epoch: 1,
    configuration: { backendId: "nova", modelId: null, mode: "build" },
  },
  cursor: "9007199254740993",
  messages: [],
  beforeSequence: null,
  run: null,
  operations: [],
  interactions: [],
  pendingInputs: [],
  capabilities,
};
const message = messageSchema.parse({
  id: "assistant",
  runId: "run",
  sequence: "9007199254740994",
  role: "assistant",
  state: "streaming",
  blocks: [{ id: "text", type: "text", text: "" }],
  createdAt: "2026-10-14T00:00:00.000Z",
});
test("every snapshot prefix and suffix equals continuous projection, including bigint and Unicode output", () => {
  const payloads = [
    { runId: "run", type: "run.changed", payload: { run: { id: "run", state: "running" } } },
    { runId: "run", type: "message.started", payload: { message } },
    {
      runId: "run",
      type: "text.delta",
      payload: { messageId: message.id, blockId: "text", offset: 0, text: "你好😀" },
    },
    { runId: "run", type: "text.reset", payload: { messageId: message.id, blockId: "text", text: "重试" } },
    { runId: "run", type: "text.delta", payload: { messageId: message.id, blockId: "text", offset: 2, text: "完成" } },
    {
      runId: "run",
      type: "tool.changed",
      payload: { operation: { id: "operation", callId: "call", state: "running" } },
    },
    {
      runId: "run",
      type: "tool.output",
      payload: { operationId: "operation", channel: "stdout", offset: 0, text: "中文😀".repeat(50000) },
    },
    {
      runId: "run",
      type: "tool.output",
      payload: { operationId: "operation", channel: "stdout", offset: 200000, text: "结束" },
    },
    {
      runId: "run",
      type: "tool.changed",
      payload: {
        operation: {
          id: "operation",
          callId: "call",
          state: "succeeded",
          stdout: outputTail("中文😀".repeat(50000) + "结束", 200002),
        },
      },
    },
    {
      runId: "run",
      type: "message.committed",
      payload: {
        message: {
          ...message,
          state: "completed",
          blocks: [
            { id: "text", type: "text", text: "重试完成" },
            { id: "custom", type: "custom", name: "future", data: { nested: [1, true, null] }, fallback: "可读内容" },
          ],
        },
      },
    },
    { runId: "run", type: "run.changed", payload: { run: { id: "run", state: "succeeded" } } },
  ];
  const events = payloads.map((event, index) =>
    productEventSchema.parse({ ...event, sequence: (BigInt(initial.cursor) + BigInt(index) + 1n).toString() }),
  );
  const final = events.reduce(applyEvent, initial);
  for (let index = 0; index <= events.length; index++) {
    const prefix = events.slice(0, index).reduce(applyEvent, initial);
    const snapshot = snapshotSchema.parse(JSON.parse(JSON.stringify(prefix)));
    assert.deepEqual(events.slice(index).reduce(applyEvent, snapshot), final);
  }
  assert.deepEqual(applyEvent(final, events[0]!), final);
  assert.ok(final.operations[0]!.stdout!.startOffset > 0);
  assert.equal(final.operations[0]!.stdout!.nextOffset, 200002);
  assert.ok(!final.operations[0]!.stdout!.text.includes("\ufffd"));
});
test("invalid core events, immutable messages, offsets, inputs and interaction answers are rejected", () => {
  assert.ok(decimalSequenceSchema.safeParse("9007199254740993").success);
  for (const value of ["01", "-1", "9223372036854775808"])
    assert.equal(decimalSequenceSchema.safeParse(value).success, false);
  assert.equal(inputBlocksSchema.safeParse([{ id: "text", type: "text", text: " " }]).success, false);
  assert.equal(
    inputBlocksSchema.safeParse([{ id: "text", type: "tool_call", callId: "x", name: "x", args: {} }]).success,
    false,
  );
  assert.equal(
    inputBlocksSchema.safeParse([
      {
        id: "file",
        type: "file",
        attachment: {
          ref: { kind: "ssh", remoteConnectionId: "remote", path: "../secret" },
          name: "file",
          mimeType: "text/plain",
        },
      },
    ]).success,
    false,
  );
  assert.ok(
    inputBlocksSchema.safeParse([
      {
        id: "file",
        type: "file",
        attachment: { ref: { kind: "object", key: "stable" }, name: "file", mimeType: "text/plain" },
      },
    ]).success,
  );
  assert.equal(
    productEventSchema.safeParse({ protocolVersion: 2, runId: "run", sequence: "1", type: "run.started", payload: {} })
      .success,
    false,
  );
  assert.throws(() =>
    applyEvent(initial, { sequence: "9007199254740995", runId: null, type: "usage.changed", payload: { usage: {} } }),
  );
  const started = applyEvent(initial, {
    sequence: "9007199254740994",
    runId: "run",
    type: "message.started",
    payload: { message },
  });
  assert.throws(() =>
    applyEvent(started, {
      sequence: "9007199254740995",
      runId: "run",
      type: "text.delta",
      payload: { messageId: "assistant", blockId: "text", offset: 1, text: "invalid" },
    }),
  );
  const committed = applyEvent(started, {
    sequence: "9007199254740995",
    runId: "run",
    type: "message.committed",
    payload: { message: { ...message, state: "completed" } },
  });
  assert.throws(() =>
    applyEvent(committed, {
      sequence: "9007199254740996",
      runId: "run",
      type: "text.delta",
      payload: { messageId: "assistant", blockId: "text", offset: 0, text: "late" },
    }),
  );
  const approval = interactionSchema.parse({
    id: "approval",
    kind: "approval",
    revision: 1,
    state: "pending",
    toolName: "write",
    args: {},
    risk: "write",
    allowedScopes: ["once"],
  });
  assert.equal(validInteractionResponse(approval, { kind: "approval", decision: "allow", scope: "session" }), false);
  const question = interactionSchema.parse({
    id: "question",
    kind: "question",
    revision: 1,
    state: "pending",
    question: "Choose",
    options: [
      { id: "a", label: "Same" },
      { id: "b", label: "Same" },
    ],
    multiSelect: false,
    allowCustom: true,
  });
  assert.ok(validInteractionResponse(question, { kind: "question", optionIds: ["b"] }));
  assert.equal(validInteractionResponse(question, { kind: "question", optionIds: ["a", "a"] }), false);
  assert.equal(validInteractionResponse(question, { kind: "question", optionIds: ["a", "b"] }), false);
  assert.ok(validInteractionResponse(question, { kind: "question", optionIds: [], customText: "Custom" }));
});
