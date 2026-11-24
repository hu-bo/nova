import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  decodeServerEnvelope,
  encodeRunnerEnvelope,
  operationParamsSha256,
} from "@nova/runner-protocol";
import { RunnerSessionImpl, parseResourceCatalog } from "../dist/index.js";

const DIGEST_A = "a".repeat(64);

function identityWith(capabilities) {
  return {
    runnerId: "runner-1",
    bootId: "boot-1",
    protocolVersion: 2,
    version: "0.0.0",
    platform: "windows",
    workspaces: [{ workspaceId: "ws-1", displayName: "ws-1", permission: "READ_WRITE" }],
    capabilities,
    maxConcurrency: 4,
  };
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.readyState = 1; // ws.OPEN
  }
  send(data, _options, callback) {
    this.sent.push(Uint8Array.from(data));
    callback?.();
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

function attach(capabilities = ["filesystem", "local_resources", "local_resources.write"]) {
  const diagnostics = [];
  const session = new RunnerSessionImpl(identityWith(capabilities), "user-1", (item) =>
    diagnostics.push(item.code),
  );
  const socket = new FakeSocket();
  session.attach(socket, "epoch-1", 10_000);
  return { session, socket, diagnostics };
}

function sentEnvelopes(socket) {
  return socket.sent.map((bytes) => decodeServerEnvelope(bytes));
}

test("refreshResources delivers a RefreshResourceCatalog frame with echo id", async () => {
  const { session, socket } = attach();
  const delivered = await session.refreshResources({
    scope: "project",
    workspaceId: "ws-1",
    relativeDir: "sub/app",
    refreshId: "refresh-1",
  });
  assert.equal(delivered.ok, true);
  const refresh = sentEnvelopes(socket).find((item) => item.payload === "refreshResourceCatalog");
  assert.ok(refresh, "refresh frame was sent");
  assert.equal(refresh.refreshResourceCatalog.refreshId, "refresh-1");
  assert.equal(refresh.requestId, "refresh-1");
  assert.equal(refresh.refreshResourceCatalog.scope, "RESOURCE_SCOPE_PROJECT");
  assert.equal(refresh.refreshResourceCatalog.workspaceId, "ws-1");
  assert.equal(refresh.refreshResourceCatalog.relativeDir, "sub/app");
});

test("capability-less runners fail with CAPABILITY_UNSUPPORTED instead of fabricated results", async () => {
  const { session, socket } = attach(["filesystem"]);
  assert.equal(session.supportsLocalResources(), false);
  assert.equal(session.supportsLocalResourceWrites(), false);
  const read = await session.readResourceSnapshot({
    kind: "skill",
    scope: "global",
    name: "demo",
    expectedSha256: DIGEST_A,
  });
  assert.equal(read.ok, false);
  assert.equal(read.error.code, "CAPABILITY_UNSUPPORTED");
  const write = await session.writeResourceFile({
    kind: "skill",
    scope: "global",
    name: "demo",
    contents: new Uint8Array(),
  });
  assert.equal(write.error.code, "CAPABILITY_UNSUPPORTED");
  const refresh = await session.refreshResources({ scope: "global" });
  assert.equal(refresh.error.code, "CAPABILITY_UNSUPPORTED");
  // 只有 welcome 帧；没有伪造任何目录或 RPC。
  assert.deepEqual(
    sentEnvelopes(socket).map((item) => item.payload),
    ["welcome"],
  );
});

test("discovery-only runners reject writes but allow snapshot reads", async () => {
  const { session } = attach(["local_resources"]);
  assert.equal(session.supportsLocalResources(), true);
  assert.equal(session.supportsLocalResourceWrites(), false);
  const write = await session.writeResourceFile({
    kind: "skill",
    scope: "global",
    name: "demo",
    contents: new Uint8Array(),
  });
  assert.equal(write.error.code, "CAPABILITY_UNSUPPORTED");
});

test("readResourceSnapshot submits an operation and validates the returned digest", async () => {
  const { session, socket } = attach();
  const contents = new TextEncoder().encode("---\nname: demo\ndescription: ok\n---\nbody\n");
  const digest = createHash("sha256").update(contents).digest("hex");
  const pending = session.readResourceSnapshot({
    kind: "skill",
    scope: "global",
    name: "demo",
    expectedSha256: digest,
  });
  const operationFrame = sentEnvelopes(socket).find((item) => item.payload === "operation");
  assert.ok(operationFrame, "operation frame was sent");
  const operation = operationFrame.operation;
  assert.equal(operation.workspaceId, "ws-1");
  assert.equal(operation.targetBootId, "boot-1");
  const request = operation.readResourceSnapshot;
  assert.equal(request.kind, "RESOURCE_KIND_SKILL");
  assert.equal(request.scope, "RESOURCE_SCOPE_GLOBAL");
  assert.equal(request.name, "demo");
  assert.equal(request.relativePath, "");
  assert.equal(request.expectedSha256, digest);
  assert.ok(operation.paramsSha256, "params digest attached");
  const result = {
    operationId: operation.operationId,
    bootId: "boot-1",
    status: "SUCCEEDED",
    readResourceSnapshot: { contents, sha256: digest, sizeBytes: String(contents.byteLength) },
  };
  socket.emit(
    "message",
    Buffer.from(encodeRunnerEnvelope({ requestId: operation.operationId, payload: undefined, result })),
    true,
  );
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.deepEqual([...outcome.value.contents], [...contents]);
  assert.equal(outcome.value.sha256, digest);
});

test("readResourceSnapshot rejects integrity-mismatched payloads and bad locators", async () => {
  const { session, socket } = attach();
  const badLocator = await session.readResourceSnapshot({
    kind: "skill",
    scope: "global",
    workspaceId: "ws-1", // global 不允许带 workspace
    name: "demo",
    expectedSha256: DIGEST_A,
  });
  assert.equal(badLocator.ok, false);
  assert.equal(badLocator.error.code, "INVALID");
  const badName = await session.readResourceSnapshot({
    kind: "skill",
    scope: "project",
    workspaceId: "ws-1",
    name: "Bad/../Name",
    expectedSha256: DIGEST_A,
  });
  assert.equal(badName.error.code, "INVALID");
  const missingDigest = await session.readResourceSnapshot({
    kind: "skill",
    scope: "global",
    name: "demo",
    expectedSha256: "nope",
  });
  assert.equal(missingDigest.error.code, "INVALID");
  // 内容摘要不符 → IO integrity 失败，不返回内容。
  const contents = new TextEncoder().encode("abc");
  const pending = session.readResourceSnapshot({
    kind: "agent",
    scope: "global",
    name: "helper",
    expectedSha256: DIGEST_A,
  });
  const operation = sentEnvelopes(socket)
    .filter((item) => item.payload === "operation")
    .at(-1).operation;
  socket.emit(
    "message",
    Buffer.from(
      encodeRunnerEnvelope({
        requestId: operation.operationId,
        result: {
          operationId: operation.operationId,
          bootId: "boot-1",
          status: "SUCCEEDED",
          readResourceSnapshot: {
            contents,
            sha256: createHash("sha256").update("tampered").digest("hex"),
            sizeBytes: "3",
          },
        },
      }),
    ),
    true,
  );
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, "IO");
});

test("writeResourceFile submits contents and maps the created flag", async () => {
  const { session, socket } = attach();
  const contents = new TextEncoder().encode("---\nname: fresh\ndescription: ok\n---\n");
  const pending = session.writeResourceFile({
    kind: "skill",
    scope: "project",
    workspaceId: "ws-1",
    relativeDir: ".",
    name: "fresh",
    contents,
  });
  const operation = sentEnvelopes(socket).find((item) => item.payload === "operation").operation;
  const request = operation.writeResourceFile;
  assert.equal(request.kind, "RESOURCE_KIND_SKILL");
  assert.equal(request.scope, "RESOURCE_SCOPE_PROJECT");
  assert.equal(request.relativeDir, ".");
  assert.deepEqual([...request.contents], [...contents]);
  assert.equal(request.expectedSha256, "");
  socket.emit(
    "message",
    Buffer.from(
      encodeRunnerEnvelope({
        requestId: operation.operationId,
        result: {
          operationId: operation.operationId,
          bootId: "boot-1",
          status: "SUCCEEDED",
          writeResourceFile: { sha256: DIGEST_A, sizeBytes: String(contents.byteLength), created: true },
        },
      }),
    ),
    true,
  );
  const outcome = await pending;
  assert.deepEqual(outcome, {
    ok: true,
    value: { sha256: DIGEST_A, sizeBytes: contents.byteLength, created: true },
  });
});

test("resource catalog frames are parsed and delivered to listeners", () => {
  const { session, socket } = attach();
  const received = [];
  const unsubscribe = session.onResourceCatalog((catalog) => received.push(catalog));
  socket.emit(
    "message",
    Buffer.from(
      encodeRunnerEnvelope({
        requestId: "catalog-1",
        resourceCatalogPublished: {
          catalogRevision: "3",
          refreshId: "refresh-1",
          complete: false,
          entries: [
            {
              kind: "RESOURCE_KIND_AGENT",
              scope: "RESOURCE_SCOPE_PROJECT",
              workspaceId: "ws-1",
              relativeDir: "sub/app",
              name: "reviewer",
              description: "审查者",
              sha256: DIGEST_A,
              sizeBytes: "128",
            },
          ],
          diagnostics: [{ code: "truncated", message: "entry cap reached", name: "", path: "" }],
        },
      }),
    ),
    true,
  );
  assert.equal(received.length, 1);
  const catalog = received[0];
  assert.equal(catalog.catalogRevision, 3);
  assert.equal(catalog.refreshId, "refresh-1");
  assert.equal(catalog.complete, false);
  assert.equal(catalog.entries[0].kind, "agent");
  assert.equal(catalog.entries[0].scope, "project");
  assert.equal(catalog.entries[0].relativeDir, "sub/app");
  assert.equal(catalog.diagnostics[0].code, "truncated");
  unsubscribe();
  socket.emit(
    "message",
    Buffer.from(encodeRunnerEnvelope({ requestId: "catalog-2", resourceCatalogPublished: { catalogRevision: "4" } })),
    true,
  );
  assert.equal(received.length, 1, "listener removed after unsubscribe");
});

test("malformed catalog frames raise a diagnostic without closing the connection", () => {
  const { session, socket, diagnostics } = attach();
  const received = [];
  session.onResourceCatalog((catalog) => received.push(catalog));
  socket.emit(
    "message",
    Buffer.from(
      encodeRunnerEnvelope({
        requestId: "catalog-bad",
        resourceCatalogPublished: {
          catalogRevision: "5",
          entries: [
            {
              kind: "RESOURCE_KIND_SKILL",
              scope: "RESOURCE_SCOPE_GLOBAL",
              name: "demo",
              sha256: "absolute/path/not/allowed",
              sizeBytes: "1",
            },
          ],
        },
      }),
    ),
    true,
  );
  assert.equal(received.length, 0);
  assert.ok(diagnostics.includes("RUNNER_RESOURCE_CATALOG_INVALID"));
  assert.equal(socket.readyState, 1, "connection survives an invalid catalog frame");
});

test("parseResourceCatalog mirrors the diagnostic code contract", () => {
  const catalog = parseResourceCatalog({
    catalogRevision: "1",
    complete: true,
    entries: [],
    diagnostics: [{ code: "path_escape", message: "escape", name: "x", path: "x/SKILL.md" }],
  });
  assert.equal(catalog.diagnostics[0].code, "path_escape");
  assert.throws(() =>
    parseResourceCatalog({ catalogRevision: "1", diagnostics: [{ code: "made_up", message: "?" }] }),
  );
  assert.throws(() =>
    parseResourceCatalog({ catalogRevision: "1", diagnostics: [{ code: "truncated", message: "?", path: "C:/abs" }] }),
  );
});

// 与 crates/runner/src/digest.rs 的 resource_operation_digests_are_stable_and_discriminating
// 输出一致：锁定跨语言 canonical 摘要，防止双侧漂移（P0-D1 协议测试）。
test("operation digests for resource params match the pinned Rust fixtures", () => {
  const base = {
    operationId: "op-1",
    targetBootId: "boot-1",
    workspaceId: "ws-1",
    protocolVersion: 2,
    expiresAtUnixMs: "1800000000000",
    timeoutMs: 10_000,
  };
  const read = {
    ...base,
    readResourceSnapshot: {
      kind: "RESOURCE_KIND_SKILL",
      scope: "RESOURCE_SCOPE_GLOBAL",
      name: "snap",
      expectedSha256: DIGEST_A,
    },
  };
  assert.equal(
    Buffer.from(operationParamsSha256(read)).toString("hex"),
    "69c087162832748fe2db0536516eee43b0c7a39282048169990b6bfcc58d0c79",
  );
  const write = {
    ...base,
    writeResourceFile: {
      kind: "RESOURCE_KIND_SKILL",
      scope: "RESOURCE_SCOPE_PROJECT",
      workspaceId: "ws-1",
      relativeDir: "sub",
      name: "created",
      contents: Uint8Array.from(Buffer.from("payload")),
    },
  };
  assert.equal(
    Buffer.from(operationParamsSha256(write)).toString("hex"),
    "9524a1cef4c5030bcb7d9632c3e983dcbf16f756eb648411467623d7aa7727de",
  );
  const del = {
    ...base,
    deleteWorkspacePaths: {
      relativePaths: [".nova/runs/run-1/tmp", ".nova/runs/run-2/tmp"],
    },
  };
  assert.equal(
    Buffer.from(operationParamsSha256(del)).toString("hex"),
    "858ae42806ee8d73825d445c8c7452d7ef2e790c3c2df7e834c78fa842d32ab4",
  );
  // 顺序参与摘要（与 Rust reordered 断言一致）。
  const reordered = { ...base, deleteWorkspacePaths: { relativePaths: [".nova/runs/run-2/tmp", ".nova/runs/run-1/tmp"] } };
  assert.notEqual(
    Buffer.from(operationParamsSha256(reordered)).toString("hex"),
    Buffer.from(operationParamsSha256(del)).toString("hex"),
  );
});

test("deleteWorkspacePaths submits an operation and maps removed", async () => {
  const { session, socket } = attach();
  const pending = session.deleteWorkspacePaths({
    workspaceId: "ws-1",
    relativePaths: [".nova/runs/run-1/tmp", ".nova/runs/run-9/tmp"],
  });
  const operation = sentEnvelopes(socket).find((item) => item.payload === "operation").operation;
  assert.equal(operation.workspaceId, "ws-1");
  const request = operation.deleteWorkspacePaths;
  assert.deepEqual(request.relativePaths, [".nova/runs/run-1/tmp", ".nova/runs/run-9/tmp"]);
  assert.ok(operation.paramsSha256, "params digest attached");
  socket.emit(
    "message",
    Buffer.from(
      encodeRunnerEnvelope({
        requestId: operation.operationId,
        result: {
          operationId: operation.operationId,
          bootId: "boot-1",
          status: "SUCCEEDED",
          deleteWorkspacePaths: { removed: 1 },
        },
      }),
    ),
    true,
  );
  const outcome = await pending;
  assert.deepEqual(outcome, { ok: true, value: { removed: 1 } });
});

test("deleteWorkspacePaths distinguishes unsupported capability from errors", async () => {
  // 无 local_resources.write 能力：CAPABILITY_UNSUPPORTED，且不发送任何 operation 帧。
  const { session, socket } = attach(["filesystem", "local_resources"]);
  assert.equal(session.supportsLocalResourceWrites(), false);
  const outcome = await session.deleteWorkspacePaths({
    workspaceId: "ws-1",
    relativePaths: [".nova/runs/run-1/tmp"],
  });
  assert.equal(outcome.error.code, "CAPABILITY_UNSUPPORTED");
  assert.deepEqual(
    sentEnvelopes(socket).map((item) => item.payload),
    ["welcome"],
    "no operation frame is fabricated",
  );
});

test("deleteWorkspacePaths validates batch before dispatch", async () => {
  const { session, socket } = attach();
  const before = sentEnvelopes(socket).length;
  const cases = [
    { relativePaths: [], code: "INVALID" }, // 空批次
    { relativePaths: ["."], code: "INVALID" }, // 工作区根
    { relativePaths: ["../outside"], code: "INVALID" }, // 越界
    { relativePaths: ["/abs/tmp"], code: "INVALID" }, // 绝对路径
    { relativePaths: [".nova/runs/../run-x/tmp"], code: "INVALID" }, // 注入 ..
    { relativePaths: Array.from({ length: 65 }, (_, i) => `.nova/runs/run-${i}/tmp`), code: "INVALID" }, // 超 64
    { relativePaths: [".nova/runs/run-1/tmp"], workspace: "nope", code: "INVALID" }, // 未注册工作区
  ];
  for (const testCase of cases) {
    const outcome = await session.deleteWorkspacePaths({
      workspaceId: testCase.workspace ?? "ws-1",
      relativePaths: testCase.relativePaths,
    });
    assert.equal(outcome.ok, false, JSON.stringify(testCase));
    assert.equal(outcome.error.code, testCase.code, JSON.stringify(testCase));
  }
  assert.equal(sentEnvelopes(socket).length, before, "no frames dispatched for invalid batches");
});

test("deleteWorkspacePaths respects read-only workspace registration", async () => {
  const diagnostics = [];
  const session = new RunnerSessionImpl(
    {
      runnerId: "runner-1",
      bootId: "boot-1",
      protocolVersion: 2,
      version: "0.0.0",
      platform: "windows",
      workspaces: [{ workspaceId: "ws-1", displayName: "ws-1", permission: "READ_ONLY" }],
      capabilities: ["filesystem", "local_resources", "local_resources.write"],
      maxConcurrency: 4,
    },
    "user-1",
    (item) => diagnostics.push(item.code),
  );
  const socket = new FakeSocket();
  session.attach(socket, "epoch-1", 10_000);
  const outcome = await session.deleteWorkspacePaths({
    workspaceId: "ws-1",
    relativePaths: [".nova/runs/run-1/tmp"],
  });
  assert.equal(outcome.error.code, "DENIED");
});
