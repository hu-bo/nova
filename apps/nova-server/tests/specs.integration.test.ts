import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import test from "node:test";
import { createDatabase, conversations, pendingInputs, projects, runnerOperations, runs } from "../database/index.js";
import { SpecService } from "../src/modules/specs/spec.service.js";
import { createRunService } from "../src/modules/runs/run.service.js";
import "../src/modules/runs/nova-runtime.js";
import { DomainError } from "../src/shared/domain-error.js";

const url = process.env.TEST_DATABASE_URL;
const requirements = (value: string) => `# Export\n\n## 验收条件\n\n### AC-01 导出\n\n${value}\n`;
const taskPlan = [
  { key: "T-01", title: "准备内容", objective: "准备可导出的内容。", dependsOn: [], checks: [{ key: "C-01", criterionIds: ["AC-01"], label: "内容可读", method: { kind: "command" as const, command: "printf", args: ["ok"] } }] },
  { key: "T-02", title: "验证导出", objective: "确认导出结果。", dependsOn: ["T-01"], checks: [{ key: "C-01", criterionIds: ["AC-01"], label: "文件可下载", method: { kind: "manual" as const } }] },
];

test("spec workflow is revision-safe, idempotent, permission-scoped, and evidence-bound", { skip: !url }, async (t) => {
  const admin = new Pool({ connectionString: url });
  const schemaName = "nova_sdd_test_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA "${schemaName}"`);
  const scopedUrl = new URL(url!);
  scopedUrl.searchParams.set("options", `-c search_path=${schemaName}`);
  const pool = new Pool({ connectionString: scopedUrl.toString() });
  const db = createDatabase(pool);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    await admin.end();
  });

  const directory = new URL("../database/migrations/", import.meta.url);
  const migrations = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of migrations) await pool.query(await readFile(new URL(file, directory), "utf8"));

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, ownerUserId: ownerId, name: "SDD integration" });
  const service = new SpecService(db);
  const firstQuery = "请为项目增加会话导出功能";
  const startInput = { title: firstQuery, brief: firstQuery, startGeneration: true };
  const [started, replayed] = await Promise.all([
    service.create(projectId, ownerId, startInput, "first-query"),
    service.create(projectId, ownerId, startInput, "first-query"),
  ]);
  assert.equal(started.id, replayed.id);
  const initialQueue = await db.select().from(pendingInputs).where(eq(pendingInputs.conversationId, started.conversationId));
  assert.equal(initialQueue.length, 1, "Spec creation and first generation must enqueue atomically and idempotently");
  assert.equal(initialQueue[0]?.payload.blocks[0]?.type, "text");
  assert.deepEqual(initialQueue[0]?.payload.blocks, [{ id: "text", type: "text", text: firstQuery }]);
  assert.equal(initialQueue[0]?.payload.configuration?.mode, "plan");
  const initialConversation = (await db.select().from(conversations).where(eq(conversations.id, started.conversationId)))[0]!;
  assert.equal(initialConversation.metadata.specId, started.id);
  const created = await service.create(projectId, ownerId, { title: "导出", brief: "导出规格内容" }, "create-once");
  assert.deepEqual(await service.create(projectId, ownerId, { title: "导出", brief: "导出规格内容" }, "create-once"), created);
  await assert.rejects(service.get(randomUUID(), created.id, ownerId), (error) => error instanceof DomainError && error.code === "NOT_FOUND");
  await assert.rejects(service.get(projectId, created.id, randomUUID()), (error) => error instanceof DomainError && error.code === "NOT_FOUND");

  const generation = await service.generate(projectId, created.id, ownerId, 1, "requirements", undefined, undefined, "late-generation");
  const savedInitial = await service.save(projectId, created.id, ownerId, 1, "requirements", requirements("手动保存的当前内容。"));
  const duplicateGeneration = await service.generate(projectId, created.id, ownerId, 1, "requirements", undefined, undefined, "late-generation");
  assert.equal(duplicateGeneration.pendingInputId, generation.pendingInputId);

  const conversation = (await db.select().from(conversations).where(eq(conversations.id, created.conversationId)))[0]!;
  const runId = randomUUID();
  const workerId = "sdd-test-worker";
  const lateText = requirements("不应覆盖手动保存版本的迟到生成内容。");
  const projection = {
    conversation: { id: conversation.id, title: conversation.title, mode: conversation.mode, projectId, epoch: conversation.contextEpoch, configuration: { backendId: "nova", modelId: null, mode: "plan" } },
    cursor: conversation.lastEventSequence.toString(),
    messages: [{ id: randomUUID(), runId, sequence: "1", role: "assistant", state: "completed", blocks: [{ id: randomUUID(), type: "text", text: lateText }], createdAt: new Date().toISOString() }],
    beforeSequence: null, run: null, operations: [], interactions: [], pendingInputs: [], capabilities: { tools: false, approval: false, question: false, steering: false, resume: false, compact: false, images: false, files: false },
  };
  const checkpoint = {
    backendId: "nova", epoch: conversation.contextEpoch, configuration: { backendId: "nova", modelId: null, mode: "plan" }, nativeState: { messages: [], runs: [] },
    executions: [], interactions: [], approvals: [], reservedInputs: [],
    specExecution: { kind: "generation", specId: created.id, revision: 1, stage: "requirements" },
  };
  await db.insert(runs).values({ id: runId, conversationId: conversation.id, state: "running", workerId, fence: 1, leaseUntil: new Date(Date.now() + 60_000), checkpoint: checkpoint as never, checkpointRevision: 1, revision: 1, projection: projection as never });
  await db.update(pendingInputs).set({ status: "consumed", runId }).where(eq(pendingInputs.id, generation.pendingInputId));
  await db.update(conversations).set({ activeRunId: runId }).where(eq(conversations.id, conversation.id));
  await createRunService(db).finish({ id: runId, conversationId: conversation.id, workerId, fence: 1 }, "succeeded");
  const afterLateGeneration = await service.get(projectId, created.id, ownerId);
  assert.equal(afterLateGeneration.currentRevision, savedInitial.revision);
  assert.equal(afterLateGeneration.requirementsMd, requirements("手动保存的当前内容。"));

  const revision = afterLateGeneration.revision;
  const concurrent = await Promise.allSettled([
    service.save(projectId, created.id, ownerId, revision, "requirements", requirements("并发保存 A。")),
    service.save(projectId, created.id, ownerId, revision, "requirements", requirements("并发保存 B。")),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  const conflict = concurrent.find((result) => result.status === "rejected");
  assert.ok(conflict?.status === "rejected" && conflict.reason instanceof DomainError && conflict.reason.code === "CONFLICT");
  let current = await service.get(projectId, created.id, ownerId);
  await service.review(projectId, created.id, ownerId, current.revision, "requirements");
  current = await service.save(projectId, created.id, ownerId, current.revision, "design", "# 设计\n\n采用独立导出流程。\n");
  await service.review(projectId, created.id, ownerId, current.revision, "design");
  current = await service.save(projectId, created.id, ownerId, current.revision, "tasks", taskPlan);
  await service.review(projectId, created.id, ownerId, current.revision, "tasks");

  await assert.rejects(service.startAttempt(projectId, created.id, "T-02", ownerId, current.revision, undefined, "blocked-dependency"), (error) => error instanceof DomainError && error.code === "CONFLICT");
  const [first, duplicate] = await Promise.all([
    service.startAttempt(projectId, created.id, "T-01", ownerId, current.revision, undefined, "task-one"),
    service.startAttempt(projectId, created.id, "T-01", ownerId, current.revision, undefined, "task-one"),
  ]);
  assert.equal(first.attemptId, duplicate.attemptId);
  await assert.rejects(service.startAttempt(projectId, created.id, "T-01", ownerId, current.revision, undefined, "second-active"), (error) => error instanceof DomainError && error.code === "CONFLICT");

  const uncertainRunId = randomUUID();
  const callId = randomUUID();
  const uncertainCheckpoint = {
    ...checkpoint,
    executions: [{ executionId: randomUUID(), callId, name: "bash", input: { command: "make" }, dispatch: "dispatched", effects: "write", result: { status: "failed", outcome: "unknown" } }],
    specExecution: { kind: "task", specId: created.id, revision: current.revision, taskKey: "T-01", attemptId: first.attemptId },
  };
  const activeConversation = (await db.select().from(conversations).where(eq(conversations.id, conversation.id)))[0]!;
  await db.insert(runs).values({ id: uncertainRunId, conversationId: conversation.id, state: "cancelled_unconfirmed", checkpoint: uncertainCheckpoint as never, checkpointRevision: 1, revision: 1 });
  await db.update(pendingInputs).set({ status: "consumed", runId: uncertainRunId }).where(eq(pendingInputs.id, first.pendingInputId));
  await db.update(conversations).set({ activeRunId: uncertainRunId }).where(eq(conversations.id, conversation.id));
  await assert.rejects(service.reconcile(projectId, created.id, first.attemptId, ownerId, current.revision, "远端回执尚未到达"), (error) => error instanceof DomainError && error.code === "CONFLICT");
  await assert.rejects(service.startAttempt(projectId, created.id, "T-01", ownerId, current.revision, undefined, "blocked-unknown"), (error) => error instanceof DomainError && error.code === "CONFLICT");
  await db.insert(runnerOperations).values({ operationId: randomUUID(), runId: uncertainRunId, toolCallId: callId, status: "acked", knownOutcome: true });
  await service.reconcile(projectId, created.id, first.attemptId, ownerId, current.revision, "已核实原操作完成");
  const attemptEvidence = async (taskKey: string, requestKey: string, note: string) => {
    const attempt = await service.startAttempt(projectId, created.id, taskKey, ownerId, current.revision, undefined, requestKey);
    const input = (await db.select().from(pendingInputs).where(eq(pendingInputs.id, attempt.pendingInputId)))[0]!;
    await db.update(pendingInputs).set({ status: "removed" }).where(eq(pendingInputs.id, input.id));
    await service.reconcile(projectId, created.id, attempt.attemptId, ownerId, current.revision, "测试中确认无远端副作用");
    await service.recordEvidence(projectId, created.id, ownerId, { expectedRevision: current.revision, evidenceId: randomUUID(), taskKey, checkKey: "C-01", source: { kind: "manual", attemptId: attempt.attemptId, passed: true, note } });
  };
  const settleTaskAttempt = async (attempt: { attemptId: string; pendingInputId: string }, executions: Record<string, unknown>[]) => {
    const runId = randomUUID();
    const checkpointForRun = {
      ...checkpoint,
      executions,
      specExecution: { kind: "task", specId: created.id, revision: current.revision, taskKey: "T-01", attemptId: attempt.attemptId },
    };
    await db.insert(runs).values({ id: runId, conversationId: conversation.id, state: "running", workerId, fence: 1, leaseUntil: new Date(Date.now() + 60_000), checkpoint: checkpointForRun as never, checkpointRevision: 1, revision: 1, projection: { ...projection, messages: [] } as never });
    await db.update(pendingInputs).set({ status: "consumed", runId }).where(eq(pendingInputs.id, attempt.pendingInputId));
    await db.update(conversations).set({ activeRunId: runId }).where(eq(conversations.id, conversation.id));
    await createRunService(db).finish({ id: runId, conversationId: conversation.id, workerId, fence: 1 }, "succeeded");
  };
  const unmatchedAttempt = await service.startAttempt(projectId, created.id, "T-01", ownerId, current.revision, undefined, "task-one-unmatched-check");
  await settleTaskAttempt(unmatchedAttempt, [
    { executionId: randomUUID(), callId: randomUUID(), name: "bash", input: { command: "different", args: ["ok"] }, dispatch: "dispatched", effects: "read", result: { status: "succeeded", outcome: "known", value: { exitCode: 0 } } },
    { executionId: randomUUID(), callId: randomUUID(), name: "bash", input: { command: "printf", args: ["ok"] }, dispatch: "dispatched", effects: "read", result: { status: "succeeded", outcome: "known", value: { exitCode: 1 } } },
  ]);
  current = await service.get(projectId, created.id, ownerId);
  assert.equal(current.tasks.find((task) => task.key === "T-01")?.status, "needs_verification");
  assert.ok(!current.evidence.some((entry) => entry.source === "automatic" && entry.attemptId === unmatchedAttempt.attemptId));
  const automaticAttempt = await service.startAttempt(projectId, created.id, "T-01", ownerId, current.revision, undefined, "task-one-automatic-check");
  const automaticOperationId = randomUUID();
  await settleTaskAttempt(automaticAttempt, [
    { executionId: automaticOperationId, callId: randomUUID(), name: "bash", input: { command: "printf", args: ["ok"] }, dispatch: "dispatched", effects: "read", result: { status: "succeeded", outcome: "known", value: { exitCode: 0 } } },
  ]);
  current = await service.get(projectId, created.id, ownerId);
  assert.ok(current.evidence.some((entry) => entry.source === "automatic" && entry.taskKey === "T-01" && entry.checkKey === "C-01" && entry.attemptId === automaticAttempt.attemptId && entry.toolOperationId === automaticOperationId));
  await attemptEvidence("T-02", "task-two", "已检查下载结果");
  current = await service.get(projectId, created.id, ownerId);
  assert.ok(current.tasks.every((task) => task.status === "passed"));
  const oldEvidence = current.evidence;
  current = await service.accept(projectId, created.id, ownerId, current.revision);
  await assert.rejects(service.startAttempt(projectId, created.id, "T-01", ownerId, current.revision, undefined, "after-acceptance"), (error) => error instanceof DomainError && error.code === "CONFLICT");
  await assert.rejects(service.recordEvidence(projectId, created.id, ownerId, { expectedRevision: current.revision, evidenceId: randomUUID(), taskKey: "T-01", checkKey: "C-01", source: { kind: "manual", attemptId: first.attemptId, passed: true, note: "late" } }), (error) => error instanceof DomainError && error.code === "CONFLICT");

  const nextTasks = taskPlan.map((task) => task.key === "T-01" ? { ...task, objective: "在新版本中准备可导出的内容。" } : task);
  current = await service.save(projectId, created.id, ownerId, current.revision, "tasks", nextTasks);
  await service.review(projectId, created.id, ownerId, current.revision, "tasks");
  for (const old of oldEvidence) {
    await service.recordEvidence(projectId, created.id, ownerId, { expectedRevision: current.revision, evidenceId: randomUUID(), taskKey: old.taskKey, checkKey: old.checkKey, source: { kind: "carried", revision: current.revision - 1, evidenceId: old.id, note: "逐项复核后确认仍适用" } });
  }
  current = await service.accept(projectId, created.id, ownerId, current.revision);
  assert.ok(current.acceptance);
  const exported = await service.export(projectId, created.id, ownerId);
  const taskFile = exported.files.find((file) => file.name === "tasks.md");
  assert.ok(taskFile?.content.includes("## T-01"));
  assert.ok(taskFile?.content.includes("[x] C-01"));
  assert.equal(activeConversation.activeRunId, null, "the old generation run must have released the conversation");

  const skillSpec = await service.create(projectId, ownerId, { title: "会话内修订", brief: "初始需求" }, "skill-spec");
  const runService = createRunService(db);
  let sequence = 0n;
  const settleSkillDraft = async (content: string, advanceWhileRunning = false) => {
    await db.insert(pendingInputs).values({
      conversationId: skillSpec.conversationId, sequence: ++sequence, mode: "next_run", fingerprint: randomUUID(),
      payload: { blocks: [{ id: "text", type: "text", text: "请修订需求" }], mode: "next_run", configuration: { backendId: "nova", modelId: null, mode: "plan" } },
    });
    const prepared = await runService.prepare(skillSpec.conversationId, workerId);
    assert.ok(prepared?.run.checkpoint && prepared.specRevision);
    const execution = prepared.run.checkpoint.specExecution;
    assert.equal(execution?.kind, "discussion");
    assert.equal(execution?.revision, prepared.specRevision.revision, "recovery context must reference the exact saved revision");
    const operationId = randomUUID(), callId = randomUUID();
    const checkpointWithDraft: NonNullable<typeof prepared.run.checkpoint> = { ...prepared.run.checkpoint, executions: [{
      executionId: operationId, callId, runId: prepared.run.id, stepId: randomUUID(), idempotencyKey: randomUUID(),
      name: "spec_update", effects: "read", dispatch: "dispatched",
      input: { expectedRevision: prepared.specRevision.revision, stage: "requirements", content },
      result: { name: "spec_update", callId, executionId: operationId, status: "succeeded", outcome: "known", value: { baseRevision: prepared.specRevision.revision, stage: "requirements", content } },
    }] };
    await db.update(runs).set({ checkpoint: checkpointWithDraft }).where(eq(runs.id, prepared.run.id));
    if (advanceWhileRunning) await service.save(projectId, skillSpec.id, ownerId, prepared.specRevision.revision, "requirements", requirements("保留用户的新版本"));
    await runService.finish({ id: prepared.run.id, conversationId: skillSpec.conversationId, workerId, fence: prepared.run.fence }, "succeeded");
    return service.get(projectId, skillSpec.id, ownerId);
  };
  const drafted = await settleSkillDraft(requirements("由持久化的规格工具结果更新。"));
  assert.equal(drafted.revision, 2);
  assert.equal(drafted.requirementsMd, requirements("由持久化的规格工具结果更新。"));
  assert.deepEqual(drafted.reviews, {}, "Agent draft tools cannot confirm a stage");
  const staleDraft = await settleSkillDraft(requirements("迟到工具候选"), true);
  assert.equal(staleDraft.requirementsMd, requirements("保留用户的新版本"));
  assert.equal(staleDraft.revision, 3);
});
