import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PublicError } from "@nova/agent-ui-contracts";
import { ArtifactService, type PublishRequest } from "../src/modules/artifacts/artifact.service.js";
import type { ArtifactRepository, ArtifactRow } from "../src/modules/artifacts/artifact.repository.js";
import type { ArtifactSettlement } from "../src/modules/artifacts/../runs/index.js";
import type { ArtifactObjectStorage } from "../src/modules/artifacts/object-storage.js";
import { MAX_ARTIFACT_BYTES } from "../src/modules/artifacts/object-storage.js";
import type { RunClaim } from "../src/modules/runs/index.js";

/** 替身实现：与真实仓储/结算端口同语义的内存版本（参照 attachments.test.ts 的存储替身模式）。 */

class FakeArtifacts {
  rows = new Map<string, ArtifactRow>();
  private counter = 0;

  private row(partial: Partial<ArtifactRow> & { id: string; runId: string; toolExecutionId: string }): ArtifactRow {
    return {
      id: partial.id,
      runId: partial.runId,
      toolExecutionId: partial.toolExecutionId,
      skillVersionId: partial.skillVersionId ?? null,
      name: partial.name ?? "report.md",
      mimeType: partial.mimeType ?? "application/octet-stream",
      size: partial.size ?? 0,
      sha256: partial.sha256 ?? null,
      objectKey: partial.objectKey ?? null,
      state: partial.state ?? "publishing",
      preview: partial.preview ?? "download",
      recovery: partial.recovery ?? null,
      error: partial.error ?? null,
      createdAt: partial.createdAt ?? new Date(0),
      updatedAt: partial.updatedAt ?? new Date(0),
    };
  }

  async reserve(input: { runId: string; toolExecutionId: string; name: string; skillVersionId: string | null }) {
    const existing = [...this.rows.values()].find(
      (row) => row.runId === input.runId && row.toolExecutionId === input.toolExecutionId,
    );
    if (existing) return { row: existing, created: false as const };
    const id = `artifact-${(this.counter += 1)}`;
    const created = this.row({ id, runId: input.runId, toolExecutionId: input.toolExecutionId, name: input.name });
    this.rows.set(id, created);
    return { row: created, created: true as const };
  }
  async find(artifactId: string) {
    return this.rows.get(artifactId);
  }
  async quotaForRun(runId: string) {
    const rows = [...this.rows.values()].filter((row) => row.runId === runId && row.state !== "failed");
    return { files: rows.length, bytes: rows.reduce((total, row) => total + Number(row.size), 0) };
  }
  async recordFacts(
    artifactId: string,
    facts: { sha256: string; size: number; objectKey: string; mimeType: string; preview: ArtifactRow["preview"]; recovery: Record<string, unknown> },
  ) {
    const row = this.rows.get(artifactId);
    if (row && row.state === "publishing") Object.assign(row, facts);
  }
  async markReady(artifactId: string, recovery: Record<string, unknown>) {
    const row = this.rows.get(artifactId);
    if (!row || (row.state !== "publishing" && row.state !== "failed")) return undefined;
    row.state = "ready";
    row.recovery = recovery;
    return row;
  }
  async markFailed(artifactId: string, error: PublicError, recovery: Record<string, unknown>, facts?: { sha256: string; size: number; mimeType: string }) {
    const row = this.rows.get(artifactId);
    if (!row || row.state !== "publishing") return undefined;
    Object.assign(row, { state: "failed", error, recovery }, facts ? { sha256: facts.sha256, size: facts.size, mimeType: facts.mimeType } : {});
    return row;
  }
  async patchRecovery(artifactId: string, recovery: Record<string, unknown>) {
    const row = this.rows.get(artifactId);
    if (row) row.recovery = recovery;
  }
  async countReadyForRun(runId: string) {
    return [...this.rows.values()].filter((row) => row.runId === runId && row.state === "ready").length;
  }
  async listForRuns(runIds: readonly string[]) {
    return [...this.rows.values()].filter((row) => runIds.includes(row.runId));
  }
  async objectKeysForRuns(runIds: readonly string[]) {
    return [...this.rows.values()]
      .filter((row) => runIds.includes(row.runId) && row.objectKey)
      .map((row) => ({ key: row.objectKey as string }));
  }
  async referencedObjectKeys() {
    return [...this.rows.values()].filter((row) => row.objectKey).map((row) => ({ key: row.objectKey as string }));
  }
}

class FakeSettlement {
  events: { artifactId: string; state: string }[] = [];
  writable = true;
  owner = "owner-1";
  /** >0 时 settle 抛 fence 冲突（模拟上传后结算前 Worker 退出）；每次尝试递减，Infinity 表示持续失败。 */
  settleFailures = 0;
  async assertWritable(claim: RunClaim) {
    if (!this.writable) throw new Error("Run lease or fence changed");
    void claim;
  }
  async settle(claim: RunClaim, input: { artifactId: string; state: "ready" | "failed" }, mutate: () => Promise<void>) {
    if (!this.writable) throw new Error("Run lease or fence changed");
    void claim;
    if (this.settleFailures > 0) {
      // 真实实现里 settle 的事务先校验 fence 再写入；失败时 mutate 一并回滚。
      if (Number.isFinite(this.settleFailures)) this.settleFailures -= 1;
      throw new Error("Run lease or fence changed");
    }
    await mutate();
    this.events.push(input);
  }
  async resolveRunOwnership(runId: string) {
    return { runId, conversationId: "conversation-1", projectId: null, ownerUserId: this.owner };
  }
  async runIdsForConversation(conversationId: string, ownerUserId: string) {
    if (ownerUserId !== this.owner) throw new Error("Conversation not found");
    void conversationId;
    return ["run-1"];
  }
  async runStatesForIds(runIds: readonly string[]) {
    return runIds.map((id) => ({ id, state: "succeeded" as const }));
  }
}

function memoryStorage(options: { failPutWith?: unknown; statThrows?: boolean; extraObjects?: { key: string; body: Uint8Array; lastModified: Date }[] } = {}) {
  const objects = new Map<string, { body: Uint8Array; contentType: string; lastModified?: Date }>();
  for (const extra of options.extraObjects ?? [])
    objects.set(extra.key, { body: extra.body, contentType: "application/octet-stream", lastModified: extra.lastModified });
  const storage: ArtifactObjectStorage = {
    async putObject(key, body, contentType) {
      if (options.failPutWith !== undefined) throw options.failPutWith;
      objects.set(key, { body, contentType });
    },
    async statObject(key) {
      if (options.statThrows) throw new Error("storage unavailable");
      const found = objects.get(key);
      return found ? { size: found.body.byteLength, etag: "etag" } : undefined;
    },
    async readObject(key, maxBytes) {
      const found = objects.get(key);
      if (!found) return undefined;
      return { body: found.body.slice(0, maxBytes), truncated: found.body.byteLength > maxBytes };
    },
    async removeObject(key) {
      objects.delete(key);
    },
    async presignGet(key) {
      return { url: `https://storage.example/${encodeURIComponent(key)}`, expiresAt: new Date(Date.now() + 300_000).toISOString() };
    },
    async listObjects(prefix) {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, found]) => ({ key, size: found.body.byteLength, lastModified: found.lastModified ?? new Date() }));
    },
  };
  return { storage, objects };
}

const claim: RunClaim = { id: "run-1", conversationId: "conversation-1", workerId: "worker-1", fence: 1 };

function harness(options?: {
  failPutWith?: unknown;
  statThrows?: boolean;
  writable?: boolean;
  settleFailures?: number;
  extraObjects?: { key: string; body: Uint8Array; lastModified: Date }[];
}) {
  const artifacts = new FakeArtifacts();
  const settlement = new FakeSettlement();
  if (options && options.writable === false) settlement.writable = false;
  if (options && options.settleFailures !== undefined) settlement.settleFailures = options.settleFailures;
  const { storage, objects } = memoryStorage(options ?? {});
  const service = new ArtifactService(
    artifacts as unknown as ArtifactRepository,
    settlement as unknown as ArtifactSettlement,
    storage,
    async (run) => run({ artifacts: artifacts as unknown as ArtifactRepository, settlement: settlement as unknown as ArtifactSettlement }),
  );
  return { service, artifacts, settlement, objects };
}

const markdown = Buffer.from("# 报告\n通过 12 项检查。\n", "utf8");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function request(bytes: Uint8Array, over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    claim,
    toolExecutionId: "exec-1",
    skillVersionId: "skill-version-1",
    display: "report.md",
    readBytes: async () => bytes,
    ...over,
  };
}

test("publish freezes bytes, uploads the immutable key and settles ready with the artifact.changed event", async () => {
  const { service, artifacts, settlement, objects } = harness();
  const result = await service.publish(request(markdown));
  assert.equal(result.sha256, digest(markdown));
  assert.equal(result.sizeBytes, markdown.byteLength);
  assert.equal(result.replayed, false);
  const row = artifacts.rows.get(result.artifactId)!;
  assert.equal(row.state, "ready");
  assert.equal(row.mimeType, "text/markdown");
  assert.equal(row.preview, "markdown");
  assert.ok(row.objectKey!.startsWith("artifacts/owner-1/conversation-1/run-1/"));
  assert.equal([...objects.keys()].length, 1);
  assert.deepEqual(settlement.events, [{ artifactId: result.artifactId, state: "ready" }]);
});

test("same tool execution replays the original artifact, different run does not collide", async () => {
  const { service, artifacts } = harness();
  const first = await service.publish(request(markdown));
  const replay = await service.publish(request(markdown));
  assert.equal(replay.artifactId, first.artifactId);
  assert.equal(replay.replayed, true);
  const other = await service.publish(request(markdown, { toolExecutionId: "exec-2" }));
  assert.notEqual(other.artifactId, first.artifactId);
  assert.equal(artifacts.rows.size, 2);
  // 同名不同 Run 不覆盖（§10 P1 行）。
  assert.notEqual(artifacts.rows.get(first.artifactId)!.objectKey, artifacts.rows.get(other.artifactId)!.objectKey);
});

test("oversized and disallowed file types settle failed and release the quota slot", async () => {
  const { service, artifacts, settlement } = harness();
  await assert.rejects(
    () => service.publish(request(new Uint8Array(MAX_ARTIFACT_BYTES + 1))),
    (error: { code: string; details?: unknown }) =>
      error.code === "CONFLICT" && JSON.stringify(error.details).includes("TOO_LARGE"),
  );
  const oversizeRow = [...artifacts.rows.values()].find((row) => row.state === "failed")!;
  assert.equal(oversizeRow.error?.code, "TOO_LARGE");
  assert.deepEqual(settlement.events.at(-1), { artifactId: oversizeRow.id, state: "failed" });

  await assert.rejects(
    () => service.publish(request(Buffer.from("bin"), { display: "malware.exe", toolExecutionId: "exec-exe" })),
    (error: { details?: unknown }) => JSON.stringify(error.details).includes("UNSUPPORTED_MEDIA"),
  );
  // failed 行不再占额度：run 内仍可以新执行继续发布。
  const ok = await service.publish(request(markdown, { toolExecutionId: "exec-3" }));
  assert.equal(ok.replayed, false);
});

test("crash after upload settles from the object on replay without re-uploading (window: uploaded but unsettled)", async () => {
  // settleFailures=1：reserve/put 正常，第一次 settle 抛 fence 冲突（模拟上传成功后、结算前 Worker 退出）。
  const { service, artifacts, objects } = harness({ settleFailures: 1 });
  await assert.rejects(() => service.publish(request(markdown)));
  const pending = [...artifacts.rows.values()][0];
  assert.equal(pending.state, "publishing");
  assert.equal(objects.size, 1);
  // 恢复：新 Worker 沿用发布键，核对对象后直接结算，不重新上传、不重复产物。
  const recovered = await service.publish(request(markdown));
  assert.equal(recovered.artifactId, pending.id);
  assert.equal(recovered.replayed, true);
  assert.equal(artifacts.rows.get(pending.id)!.state, "ready");
});

test("upload timeout keeps the record pending and does not redispatch on NotFound", async () => {
  const { service, artifacts } = harness({ failPutWith: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
  await assert.rejects(
    () => service.publish(request(markdown)),
    (error: { code: string }) => error.code === "EXECUTION_OUTCOME_UNKNOWN",
  );
  const row = [...artifacts.rows.values()][0];
  assert.equal(row.state, "publishing");
  assert.equal(row.recovery?.uploadStarted, true);
  // 结果未知时不能把一次失败当作可重新派发依据（此处 failPut 持续，重放仍 OUTCOME_UNKNOWN）。
  await assert.rejects(
    () => service.publish(request(markdown)),
    (error: { code: string }) => error.code === "EXECUTION_OUTCOME_UNKNOWN",
  );
});

test("stale fence cannot settle even when upload completed; the record stays publishing", async () => {
  // settleFailures=Infinity：put 成功但 settle 永远失败 → 旧 Worker 无法提交可见记录，产物停在 publishing。
  const { service, artifacts, objects } = harness({ settleFailures: Infinity });
  await assert.rejects(
    () => service.publish(request(markdown)),
    (error: unknown) => String(error).includes("lease or fence changed"),
  );
  const row = [...artifacts.rows.values()][0];
  assert.equal(row.state, "publishing");
  assert.equal(objects.size, 1);
});

test("download and preview authorize through the run chain; foreign owners get NOT_FOUND", async () => {
  const { service } = harness();
  const published = await service.publish(request(markdown));
  const file = await service.download(published.artifactId, "owner-1");
  assert.equal(file.name, "report.md");
  assert.ok(file.url.includes("artifacts"));
  const preview = await service.preview(published.artifactId, "owner-1");
  assert.equal(preview.kind, "markdown");
  assert.match((preview as { text: string }).text, /通过 12 项检查/);
  await assert.rejects(() => service.download(published.artifactId, "owner-2"), { code: "NOT_FOUND" });
  await assert.rejects(() => service.preview(published.artifactId, "owner-2"), { code: "NOT_FOUND" });

  const html = await service.publish(request(Buffer.from("<script>alert(1)</script>"), { display: "page.html", toolExecutionId: "exec-html" }));
  const htmlPreview = await service.preview(html.artifactId, "owner-1");
  assert.equal(htmlPreview.kind, "download");
});

test("listing walks the run chain and delivery settlement counts ready artifacts", async () => {
  const { service } = harness();
  const published = await service.publish(request(markdown));
  const list = await service.list({ conversationId: "conversation-1", ownerUserId: "owner-1", limit: 10 });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0]!.id, published.artifactId);
  assert.equal(list.items[0]!.state, "ready");
  assert.ok(await service.hasReadyArtifacts("run-1"));
  assert.ok(!(await service.hasReadyArtifacts("run-other")));
});

test("purge job handler removes queued object keys idempotently (P1-F1)", async () => {
  const { service, objects } = harness();
  const published = await service.publish(request(markdown));
  const key = [...objects.keys()][0]!;
  const removed = await service.handlePurgeJob({ conversationId: "conversation-1", keys: [key, key, "missing/key"] });
  assert.deepEqual(removed, { removed: 3 });
  assert.equal(objects.size, 0);
  void published;
});

test("orphan scan only deletes unreferenced artifact-shaped objects past the protection window", async () => {
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const { service, objects } = harness({
    extraObjects: [
      { key: "artifacts/owner-1/conversation-1/run-1/artifact-9/" + "f".repeat(64), body: Buffer.from("orphan"), lastModified: old },
      { key: "artifacts/owner-1/conversation-1/run-1/artifact-10/" + "e".repeat(64), body: Buffer.from("recent"), lastModified: new Date() },
      { key: "uploads/owner-1/other.png", body: Buffer.from("attachment"), lastModified: old },
    ],
  });
  const published = await service.publish(request(markdown));
  const referencedKey = [...objects.keys()].find((key) => key !== undefined && key.includes(published.artifactId))!;
  const result = await service.scanOrphans();
  assert.equal(result.removed, 1);
  assert.ok(objects.has(referencedKey), "数据库引用的对象不删");
  assert.ok([...objects.keys()].some((key) => key.includes("artifact-10")), "保护期内新对象不删");
  assert.ok(objects.has("uploads/owner-1/other.png"), "非产物前缀形状不触碰");
  assert.ok(!([...objects.keys()].some((key) => key.includes("artifact-9"))), "孤儿超期对象回收");
});
