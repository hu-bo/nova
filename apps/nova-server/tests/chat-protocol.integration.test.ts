import { ModelConfigService } from "../src/modules/model-config/model-config.service.js";
import { createModelConfigRepository } from "../src/modules/model-config/model-config.repository.js";
import { createModelBodySchema } from "../src/modules/model-config/model-config.schema.js";
import { createRunRepository } from "../src/modules/runs/run.repository.js";
import { readCheckpoint } from "../src/modules/runs/session-checkpoint.repository.js";
import { createScope, defineService } from "../src/shared/scope.js";
import { createProjectRepository } from "../src/modules/projects/project.repository.js";
import { runJournal } from "../src/modules/runs/run.repository.js";
import { EventRetentionService } from "../src/modules/events/event.service.js";
import { RunnerTokenService } from "../src/modules/runners/runner-token.service.js";
import { RunnerRegistrationService } from "../src/modules/runners/runner-registration.service.js";
import { createRunnerTokenRepository } from "../src/modules/runners/runner-token.repository.js";
import { createRunnerRepository } from "../src/modules/runners/runner.repository.js";
import { createRunnerReader } from "../src/modules/runners/index.js";
import { ProjectBindingService } from "../src/modules/projects/project-binding.service.js";
import { createProjectBindingRepository } from "../src/modules/projects/project-binding.repository.js";
import { AttachmentService } from "../src/modules/attachments/attachment.service.js";
import { disabledUploadStorage } from "../src/modules/attachments/upload-storage.js";
import { createUnitOfWork } from "../src/shared/unit-of-work.js";
import { messages, projects, projectBindings, runners, runnerTokens } from "../database/index.js";
import { createConversationReader, createConversationEventHeads } from "../src/modules/conversations/index.js";
import { createUiEventWriter, createEventRetentionService } from "../src/modules/events/index.js";
import { createEventService } from "../src/modules/events/index.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createUserModelProfilesService } from "../src/modules/model-config/index.js";
import { createRemoteService } from "../src/modules/remotes/index.js";
import { createCredentialCipher } from "../src/shared/credential-cipher.js";
import { DEV_LOCAL_USER_ID, DEV_MOCK_ACCESS_TOKEN } from "@nova/agent-ui-contracts/dev-auth";
import type { RunnerSession } from "@nova/runner-sdk";
import { Pool } from "pg";
import { and, asc, eq, sql, getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../database/schema/index.js";
import { createCodingHarness } from "@nova/coding-harness";
import {
  defineTool,
  Context,
  diagnostics,
  eventObservers,
  sessionPersistence,
  sessionStore,
  commitSessionUpdate,
  applySessionCommit,
  type AgentEvent,
  FrameworkError,
  type SessionCommit,
  type SessionSnapshot,
  type PluginDefinition,
  modelRouter,
} from "@nnova/harness";
import { z } from "zod";
import { sessionCheckpointPolicyPlugin } from "@nnova/harness/plugins/session-checkpoint-policy";
import { applyEvent, productEventSchema, snapshotSchema, CHAT_AGENT_PROFILE, configurationSchema, type Message, type Snapshot } from "@nova/agent-ui-contracts";
import { acceptExecution, validateAgentProfile } from "../src/modules/runs/agent-profile.js";
import { careerCoachSkill } from "@nova/tools/harness";

test("chat agent admission isolates skills, permissions and immutable input snapshots", () => {
  const configuration = configurationSchema.parse({ agentProfile: CHAT_AGENT_PROFILE, mode: "plan" });
  const input = { blocks: [{ id: "text", type: "text" as const, text: "修改简历" }], mode: "next_run" as const,
    skill: { id: careerCoachSkill.id, version: careerCoachSkill.version } };
  validateAgentProfile(configuration, "chat", false);
  const accepted = acceptExecution(configuration, input);
  assert.equal(accepted.skill?.content, careerCoachSkill.content);
  assert.match(accepted.agentProfile!.systemPrompt, /Read-only permissions do not restrict rewriting text/);
  assert.doesNotMatch(accepted.agentProfile!.systemPrompt, /PLAN MODE|BUILD MODE|workspace|finish_goal|spec_read/);
  assert.equal(acceptExecution(configuration, { ...input, skill: undefined }).skill, undefined);
  for (const invalid of [
    { ...configuration, mode: "build" as const }, { ...configuration, remoteConnectionId: "remote" },
    { ...configuration, backendId: "other" }, { ...configuration, agentProfile: { id: "chat" as const, version: "2.0.0" } },
  ]) assert.throws(() => validateAgentProfile(invalid, "chat", false));
  assert.throws(() => validateAgentProfile(configuration, "project", false));
  assert.throws(() => validateAgentProfile(configuration, "chat", true));
  assert.throws(() => acceptExecution(configurationSchema.parse({}), input));
  assert.throws(() => acceptExecution(configuration, { ...input, mode: "steer" }));
  assert.throws(() => acceptExecution(configuration, { ...input, skill: { id: careerCoachSkill.id, version: "2.0.0" } }));
});
import {
  createDatabase,
  conversations,
  pendingInputs,
  runs,
  sessionCommits,
  uiEvents,
  modelConfigs,
  modelProviders,
} from "../database/index.js";
import { createConversationRepository } from "../src/modules/conversations/conversation.repository.js";
import type { RunClaim } from "../src/modules/runs/run.repository.js";
import { createRunService, type RunService as RunRepository } from "../src/modules/runs/run.service.js";
import { postgresSessionPlugin } from "../src/modules/runs/postgres-session-store.js";
import { nativeSnapshot, runtimeAdapters, type RuntimeAdapter } from "../src/modules/runs/runtime-adapter.js";
import { executionEffectState } from "../src/modules/runs/session-checkpoint.js";
import "../src/modules/runs/nova-runtime.js";
import { ConversationExecutor } from "../src/modules/runs/conversation-executor.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createAppLogger } from "../src/shared/logger.js";
import { createJobHost } from "../src/jobs/job-registry.js";
import { claim as claimJobs, enqueue as enqueueJob } from "../src/jobs/postgres-job-store.js";

const url = process.env.TEST_DATABASE_URL;
test("effect isolation ignores unconfirmed reads and retains unconfirmed writes", () => {
  const read: import("@nnova/harness").ExecutionRecord = {
    executionId: "read", runId: "run", stepId: "step", callId: "read", name: "grep", input: {},
    idempotencyKey: "read", dispatch: "dispatched", effects: "read",
    result: { executionId: "read", callId: "read", name: "grep", status: "failed", outcome: "unknown" },
  };
  assert.equal(executionEffectState([read, { ...read, executionId: "pending-read", result: undefined }]), "known");
  const write = { ...read, executionId: "write", effects: "write" as const, result: undefined };
  assert.equal(executionEffectState([read, write]), "pending");
  assert.equal(executionEffectState([read, { ...write, result: read.result }]), "unknown");
  assert.equal(executionEffectState([{ ...write, effects: undefined }]), "pending");
});
test("durable chat protocol with real PostgreSQL", { skip: !url }, async (t) => {
  const admin = new Pool({ connectionString: url });
  const name = "nova_protocol_test_" + randomUUID().replaceAll("-", "");
  await admin.query('CREATE SCHEMA "' + name + '"');
  const target = new URL(url!);
  target.searchParams.set("options", "-c search_path=" + name);
  const pool = new Pool({ connectionString: target.toString() });
  const db = createDatabase(pool);
  const scopedUow = createUnitOfWork(db);
  t.after(async () => {
    await pool.end();
    await admin.query('DROP SCHEMA "' + name + '" CASCADE');
    await admin.end();
  });
  const directory = new URL("../database/migrations/", import.meta.url);
  const migrationFiles = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of migrationFiles.filter((file) => file < "0006"))
    await pool.query(await readFile(new URL(file, directory), "utf8"));
  const owner = randomUUID(),
    legacyId = randomUUID();
  await pool.query(
    "insert into conversations(id,owner_user_id,mode,last_event_sequence,metadata) values($1,$2,'chat',3,$3)",
    [
      legacyId,
      owner,
      JSON.stringify({
        runtime: { modelId: null, executionMode: "plan", remoteConnectionId: null, reasoningEffort: null },
      }),
    ],
  );
  await pool.query("insert into messages(conversation_id,role,blocks,attachments) values($1,'user',$2,$3)", [
    legacyId,
    JSON.stringify([{ type: "text", text: "旧消息" }]),
    JSON.stringify([
      { kind: "minio", key: "old/key", summary: { mime: "image/png", size: 11, sha256: "a".repeat(64) } },
    ]),
  ]);
  await pool.query("insert into runs(conversation_id,state) values($1,'running')", [legacyId]);
  for (const file of migrationFiles.filter((file) => file >= "0006"))
    await pool.query(await readFile(new URL(file, directory), "utf8"));
  const repository = createRunService(db);
  const eventRetention = createEventRetentionService(db, createConversationEventHeads(db));
  const rawConversations = createConversationRepository(db);
  const conversationTransaction = createScope(db).serviceTransaction({ repository: rawConversations });
  const conversationRepository = {
    ...rawConversations,
    create: (...args: Parameters<typeof rawConversations.create>) =>
      conversationTransaction(({ repository }) => repository.create(...args)),
    snapshot: (...args: Parameters<typeof rawConversations.snapshot>) =>
      conversationTransaction(({ repository }) => repository.snapshot(...args), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      }),
    enqueue: (...args: Parameters<typeof rawConversations.enqueue>) =>
      conversationTransaction(({ repository }) => repository.enqueue(...args)),
    removePendingInput: (...args: Parameters<typeof rawConversations.removePendingInput>) =>
      conversationTransaction(({ repository }) => repository.removePendingInput(...args)),
    steerPendingInput: (...args: Parameters<typeof rawConversations.steerPendingInput>) =>
      conversationTransaction(({ repository }) => repository.steerPendingInput(...args)),
    updateGoal: (...args: Parameters<typeof rawConversations.updateGoal>) =>
      conversationTransaction(({ repository }) => repository.updateGoal(...args)),
    maintain: (...args: Parameters<typeof rawConversations.maintain>) =>
      conversationTransaction(({ repository }) => repository.maintain(...args)),
  };
  const newConversation = async (text = "Start") =>
    conversationRepository.create({
      ownerUserId: owner,
      mode: "chat",
      projectId: null,
      title: "Test",
      metadata: { configuration: { backendId: "nova", modelId: null, mode: "build" } },
      initialInput: { blocks: [{ id: "text", type: "text", text }] },
    });
  const claimOf = (prepared: NonNullable<Awaited<ReturnType<RunRepository["prepare"]>>>): RunClaim => ({
    id: prepared.run.id,
    conversationId: prepared.conversation.id,
    workerId: prepared.run.workerId!,
    fence: prepared.run.fence,
  });
  const snapshot = async (id: string): Promise<Snapshot> => {
    const { binding: _binding, ...core } = await conversationRepository.snapshot(id, owner);
    return snapshotSchema.parse(core);
  };
  const model = (
    tool: string,
    verify?: (request: import("@nnova/harness").ModelStepRequest) => void,
  ): PluginDefinition => ({
    manifest: {
      id: "test.model",
      version: "1.0.0",
      apiVersion: 1,
      scope: "kernel",
      requires: [],
      provides: [modelRouter],
    },
    setup(context) {
      context.provide(modelRouter, {
        id: "test",
        async *stream(request) {
          verify?.(request);
          const finished = request.messages.some((message) =>
            message.parts.some((part) => part.type === "tool-result" && part.name === tool),
          );
          if (!finished) {
            const part = { type: "tool-call" as const, callId: "logical-call", name: tool, input: {} };
            yield { type: "tool.call", callId: part.callId, name: tool, input: {} };
            yield {
              type: "message.completed",
              message: {
                role: "assistant",
                metadata: { reasoningContent: "保留原生推理" },
                parts: [{ type: "text", text: "先检查" }, part],
              },
            };
            yield { type: "finished", reason: "tool-calls" };
          } else {
            yield { type: "text.delta", partId: "text", text: "完成😀" };
            yield {
              type: "message.completed",
              message: { role: "assistant", parts: [{ type: "text", text: "完成😀" }] },
            };
            yield { type: "finished", reason: "stop" };
          }
        },
        resolve() {
          return this;
        },
      });
    },
  });
  const harness = (
    repo: RunRepository,
    claim: RunClaim,
    tool: ReturnType<typeof defineTool>,
    policy?: import("@nnova/harness").ToolPolicy,
    verify?: (request: import("@nnova/harness").ModelStepRequest) => void,
  ) =>
    createCodingHarness({
      model: { plugin: model(tool.name, verify), modelId: "test" },
      sessionId: claim.conversationId,
      tools: [tool],
      components: { sessionStore: postgresSessionPlugin(repo, claim) },
      plugins: [sessionCheckpointPolicyPlugin()],
      ...(policy ? { policies: [policy] } : {}),
    });
  await t.test("unconfirmed reads do not quarantine subsequent commands in the same workspace", async () => {
    const binding = {
      id: randomUUID(), revision: 1, runnerId: randomUUID(), workspaceId: "read-workspace", canonicalCwd: ".", instructions: {},
    };
    for (const hasResult of [false, true]) {
      const conversation = await conversationRepository.create({
        ownerUserId: owner, mode: "chat", projectId: null, title: "Unconfirmed read",
        metadata: { configuration: { backendId: "nova", modelId: null, mode: "build" }, binding },
        initialInput: { blocks: [{ id: "text", type: "text", text: "Read" }] },
      });
      const prepared = (await repository.prepare(conversation.id, "reader"))!;
      const claim = claimOf(prepared);
      const { checkpoint, revision } = await repository.load(claim);
      const executionId = randomUUID();
      const batch: SessionCommit = { execution: {
        executionId, runId: claim.id, stepId: "read-step", callId: "read-call", name: "grep",
        input: {}, idempotencyKey: randomUUID(), dispatch: "dispatched", effects: "read",
        ...(hasResult ? { result: { executionId, name: "grep", callId: "read-call", status: "failed", outcome: "unknown" } as const } : {}),
      } };
      await repository.commitSession(claim, revision, applySessionCommit(nativeSnapshot(checkpoint, revision), batch), batch);
      await repository.finish(claim, "cancelled");
      const [finished] = await db.select().from(runs).where(eq(runs.id, claim.id));
      assert.equal(finished?.state, "cancelled");
      assert.equal(finished?.effectState, "known");

      const nextConversation = await conversationRepository.create({
        ownerUserId: owner, mode: "chat", projectId: null, title: "Subsequent command",
        metadata: { configuration: { backendId: "nova", modelId: null, mode: "build" }, binding },
        initialInput: { blocks: [{ id: "text", type: "text", text: "Write" }] },
      });
      const next = (await repository.prepare(nextConversation.id, "writer"))!;
      const nextClaim = claimOf(next);
      let invoked = false;
      const tool = defineTool({
        name: "write", description: "write", inputSchema: z.object({}), effects: "write",
        async execute() { invoked = true; return {}; },
      });
      const runtime = await harness(repository, nextClaim, tool);
      try {
        const result = await runtime.run({ role: "user", parts: [{ type: "text", text: "Write" }] }, { runId: nextClaim.id });
        assert.equal(result.status, "succeeded", JSON.stringify(result));
        assert.equal(invoked, true);
      } finally { await runtime.close(); }
      await repository.finish(nextClaim, "succeeded");
    }
  });
  await t.test("forward migration preserves history and ends nonrecoverable legacy runs", async () => {
    const migrated = await snapshot(legacyId);
    assert.equal(migrated.messages[0]?.sequence, "1");
    assert.equal(migrated.messages[0]?.blocks[1]?.type, "image");
    assert.equal(migrated.conversation.configuration.mode, "plan");
    const [run] = await db.select().from(runs).where(eq(runs.conversationId, legacyId));
    assert.equal(run?.state, "failed");
    const tables = await pool.query(
      "select tablename from pg_tables where schemaname=current_schema() order by tablename",
    );
    assert.deepEqual(
      tables.rows.map((row) => row.tablename),
      Object.values(schema)
        .map((table) => getTableName(table))
        .sort(),
    );
    assert.equal(
      (await db.select().from(conversations).where(eq(conversations.id, legacyId)))[0]?.eventFloorSequence,
      3n,
    );
  });
  await t.test("synchronous event batching pauses on failure and retries a lost acknowledgement once", async () => {
    let mode: "background-failure" | "ack-loss" | "ok" = "background-failure",
      writes = 0;
    let failed!: () => void;
    const backgroundFailure = new Promise<void>((resolve) => {
      failed = resolve;
    });
    const eventRepository = {
      ...repository,
      async publishNativeEvents(claim: RunClaim, id: string, events: readonly AgentEvent[]) {
        writes++;
        if (mode === "background-failure") throw new Error("BACKGROUND_WRITE_FAILED");
        await repository.publishNativeEvents(claim, id, events);
        if (mode === "ack-loss") throw new Error("ACKNOWLEDGEMENT_LOST");
      },
    };
    const conversation = await newConversation();
    const prepared = (await eventRepository.prepare(conversation.id, "events-worker"))!,
      claim = claimOf(prepared);
    const context = new Context("session");
    context.provide(diagnostics, () => failed());
    await context.plugin(postgresSessionPlugin(eventRepository, claim));
    await context.ready();
    const observer = context.collect(eventObservers)[0]!,
      persistence = context.resolve(sessionPersistence);
    const messageId = randomUUID();
    try {
      assert.equal(
        observer.observe({ type: "message.started", sessionId: conversation.id, runId: claim.id, messageId }),
        undefined,
      );
      const delta: AgentEvent = {
        type: "assistant.delta",
        sessionId: conversation.id,
        runId: claim.id,
        messageId,
        blockId: "text",
        contentType: "text",
        text: "中文😀",
      };
      assert.equal(observer.observe(delta), undefined);
      delta.text = "mutated";
      assert.equal((await snapshot(conversation.id)).messages.length, 0);
      await Promise.race([
        backgroundFailure,
        delay(2000).then(() => {
          throw new Error("Background batch did not run");
        }),
      ]);
      assert.equal(writes, 1);
      observer.observe({ ...delta, text: "后续" });
      await delay(240);
      assert.equal(writes, 1, "background writes stay paused after failure");
      mode = "ack-loss";
      await assert.rejects(persistence.flush(), { code: "PERSISTENCE_FAILED" });
      const written = await snapshot(conversation.id);
      assert.equal(written.messages[0]?.blocks[0]?.type, "text");
      assert.equal(written.messages[0]?.blocks[0]?.type === "text" && written.messages[0].blocks[0].text, "中文😀");
      mode = "ok";
      const firstFlush = persistence.flush(),
        joinedFlush = persistence.flush();
      assert.equal(firstFlush, joinedFlush);
      await Promise.all([firstFlush, joinedFlush]);
      const completed = await snapshot(conversation.id);
      assert.equal(
        completed.messages[0]?.blocks[0]?.type === "text" && completed.messages[0].blocks[0].text,
        "中文😀后续",
      );
      const deltas = await db
        .select()
        .from(uiEvents)
        .where(and(eq(uiEvents.conversationId, conversation.id), eq(uiEvents.type, "text.delta")));
      assert.equal(deltas.length, 2, "lost acknowledgement does not duplicate deltas or sequence numbers");
      assert.equal(writes, 4);
      await persistence.flush();
      assert.deepEqual(await snapshot(conversation.id), completed);
    } finally {
      mode = "ok";
      await context.dispose();
      await eventRepository.finish(claim, "failed", "TEST_END");
    }
  });
  await t.test("native batches persist once, preserve offsets and replay exactly", async () => {
    const queries: string[] = [];
    const measured = createRunService(drizzle(pool, { schema, logger: { logQuery: (query) => queries.push(query) } }));
    const conversation = await newConversation();
    const prepared = (await repository.prepare(conversation.id, "batch-worker"))!;
    const claim = claimOf(prepared);
    const operationId = randomUUID();
    await repository.publish(claim, {
      runId: claim.id,
      type: "tool.changed",
      payload: { operation: { id: operationId, callId: randomUUID(), state: "running" } },
    });
    const before = (await db.select().from(runs).where(eq(runs.id, claim.id)))[0]!;
    const messageId = randomUUID();
    const delta = (text: string, blockId = "text", contentType: "text" | "thinking" = "text"): AgentEvent => ({
      type: "assistant.delta",
      sessionId: conversation.id,
      runId: claim.id,
      messageId,
      blockId,
      contentType,
      text,
    });
    const start: AgentEvent = { type: "message.started", sessionId: conversation.id, runId: claim.id, messageId };
    const reset: AgentEvent = { type: "assistant.reset", sessionId: conversation.id, runId: claim.id, messageId };
    const output = (offset: number, text: string): AgentEvent => ({
      type: "tool.output",
      sessionId: conversation.id,
      runId: claim.id,
      executionId: operationId,
      channel: "stdout",
      offset,
      text,
    });
    const events = [
      start,
      start,
      delta("旧😀"),
      delta("思考", "thinking", "thinking"),
      reset,
      delta("新"),
      delta("😀"),
      output(0, "工具😀"),
      output(4, "完成"),
    ];
    const batchId = randomUUID();
    await measured.publishNativeEvents(claim, batchId, events);
    assert.equal(queries.filter((query) => /^select .* from "runs" /.test(query)).length, 1);
    const runRead = queries.find((query) => /^select .* from "runs" /.test(query))!;
    assert.match(runRead, /"checkpoint" is not null/);
    assert.doesNotMatch(runRead, /"budget"|"revision"/);
    assert.equal(queries.filter((query) => query.startsWith('update "runs"')).length, 1);
    assert.equal(queries.filter((query) => query.startsWith('insert into "ui_events"')).length, 1);
    assert.equal(queries.filter((query) => query.startsWith('update "conversations"')).length, 1);
    const journal = await db
      .select()
      .from(uiEvents)
      .where(
        and(
          eq(uiEvents.conversationId, conversation.id),
          sql`${uiEvents.sequence} > ${BigInt(before.projection!.cursor)}`,
        ),
      )
      .orderBy(asc(uiEvents.sequence));
    let replay = before.projection!;
    for (const row of journal)
      replay = applyEvent(
        replay,
        productEventSchema.parse({
          runId: row.runId,
          type: row.type,
          payload: row.payload,
          sequence: row.sequence.toString(),
        }),
      );
    const after = (await db.select().from(runs).where(eq(runs.id, claim.id)))[0]!;
    assert.deepEqual(after.projection, before.projection, "streaming leaves the materialized base unchanged");
    assert.ok(
      queries.filter((query) => query.startsWith('update "runs"')).every((query) => !query.includes('"projection" =')),
    );
    assert.doesNotMatch(runRead, /"projection"/);
    const projected = (await repository.load(claim)).projection!;
    assert.deepEqual(projected, replay);
    assert.deepEqual(after.checkpoint, before.checkpoint);
    assert.equal(after.revision, before.revision);
    assert.equal(projected.operations[0]!.stdout!.text, "工具😀完成");
    assert.equal(projected.operations[0]!.stdout!.nextOffset, 6);
    const message = projected.messages.find((item) => item.id === messageId)!;
    assert.deepEqual(message.blocks, [
      { id: "text", type: "text", text: "新😀" },
      { id: "thinking", type: "thinking", text: "" },
    ]);
    assert.equal(message.sequence, (prepared.conversation.lastMessageSequence + 1n).toString());
    const [head] = await db.select().from(conversations).where(eq(conversations.id, conversation.id));
    assert.equal(head!.lastEventSequence.toString(), projected.cursor);
    assert.equal(head!.metadata.lastEventBatchId, batchId);
    queries.length = 0;
    await measured.publishNativeEvents(claim, batchId, events);
    assert.equal(queries.filter((query) => /^(update|insert)/.test(query)).length, 0);
    await assert.rejects(
      measured.publishNativeEvents(claim, randomUUID(), [delta("discard"), output(0, "stale")]),
      /offset mismatch/,
    );
    assert.deepEqual((await repository.load(claim)).projection, projected);

    // A large batch splits only the journal INSERT, never the projection/head updates.
    queries.length = 0;
    await measured.publishNativeEvents(
      claim,
      randomUUID(),
      Array.from({ length: 1001 }, () => delta("x")),
    );
    assert.equal(queries.filter((query) => query.startsWith('insert into "ui_events"')).length, 2);
    assert.equal(queries.filter((query) => query.startsWith('update "runs"')).length, 1);
    assert.equal(queries.filter((query) => query.startsWith('update "conversations"')).length, 1);
    const loaded = await repository.load(claim);
    const block = loaded.projection!.messages[0]!.blocks[0]!;
    assert.equal(block.type === "text" && block.text, "新😀" + "x".repeat(1001));
    await pool.query("update ui_events set occurred_at=now()-interval '2 days' where conversation_id=$1", [
      conversation.id,
    ]);
    await eventRetention.retain();
    assert.deepEqual(
      (await repository.load(claim)).projection,
      loaded.projection,
      "retention preserves the suffix needed by the materialized base",
    );
    await repository.finish(claim, "failed", "TEST_END");
  });
  await t.test("projection materialization follows output growth and survives retention", async () => {
    const queries: string[] = [];
    const measured = createRunService(drizzle(pool, { schema, logger: { logQuery: (query) => queries.push(query) } }));
    const conversation = await newConversation();
    const claim = claimOf((await repository.prepare(conversation.id, "materialize-worker"))!);
    const messageId = randomUUID();
    await measured.publishNativeEvents(claim, randomUUID(), [
      { type: "message.started", sessionId: conversation.id, runId: claim.id, messageId },
    ]);
    queries.length = 0;
    const text = "段😀".repeat(4096);
    for (let index = 0; index < 20; index++)
      await measured.publishNativeEvents(claim, randomUUID(), [
        {
          type: "assistant.delta",
          sessionId: conversation.id,
          runId: claim.id,
          messageId,
          blockId: "text",
          contentType: "text",
          text,
        },
      ]);
    const fullWrites = queries.filter((query) => query.startsWith('update "runs"') && query.includes('"projection" ='));
    assert.ok(fullWrites.length > 0 && fullWrites.length < 5, `${fullWrites.length} materializations for 20 flushes`);
    const loaded = await repository.load(claim);
    const block = loaded.projection!.messages[0]!.blocks[0]!;
    assert.equal(block.type === "text" && block.text, text.repeat(20));
    await pool.query("update ui_events set occurred_at=now()-interval '2 days' where conversation_id=$1", [
      conversation.id,
    ]);
    await eventRetention.retain();
    assert.deepEqual((await repository.load(claim)).projection, loaded.projection);
    await repository.finish(claim, "failed", "TEST_END");
  });
  await t.test("native batch validation and a failed head write roll back all output", async () => {
    const conversation = await newConversation();
    const claim = claimOf((await repository.prepare(conversation.id, "rollback-worker"))!);
    const messageId = randomUUID();
    const start: AgentEvent = { type: "message.started", sessionId: conversation.id, runId: claim.id, messageId };
    const delta: AgentEvent = {
      type: "assistant.delta",
      sessionId: conversation.id,
      runId: claim.id,
      messageId,
      blockId: "text",
      contentType: "text",
      text: "ok",
    };
    const state = async () => ({
      head: await db.select().from(conversations).where(eq(conversations.id, conversation.id)),
      run: await db.select().from(runs).where(eq(runs.id, claim.id)),
      journal: await db
        .select()
        .from(uiEvents)
        .where(eq(uiEvents.conversationId, conversation.id))
        .orderBy(asc(uiEvents.sequence)),
    });
    const before = await state();
    const batchId = randomUUID();
    await assert.rejects(
      repository.publishNativeEvents(claim, batchId, [start, delta, { ...delta, runId: randomUUID() }]),
      /Event run changed/,
    );
    assert.deepEqual(await state(), before);
    await assert.rejects(
      repository.publishNativeEvents(claim, batchId, [start, { ...delta, text: "x".repeat(4 * 1024 * 1024) }]),
      /storage limit/,
    );
    assert.deepEqual(await state(), before);
    await assert.rejects(
      repository.publishNativeEvents({ ...claim, fence: claim.fence + 1 }, batchId, [start, delta]),
      /lease or fence changed/,
    );
    assert.deepEqual(await state(), before);

    const constraint = "reject_batch_" + randomUUID().replaceAll("-", "");
    // Fail after both the projection UPDATE and journal INSERT have executed.
    await pool.query(
      `ALTER TABLE conversations ADD CONSTRAINT "${constraint}" CHECK (metadata->>'lastEventBatchId' IS DISTINCT FROM '${batchId}')`,
    );
    try {
      await assert.rejects(repository.publishNativeEvents(claim, batchId, [start, delta]));
      assert.deepEqual(await state(), before);
    } finally {
      await pool.query(`ALTER TABLE conversations DROP CONSTRAINT "${constraint}"`);
    }
    await repository.publishNativeEvents(claim, batchId, [start, delta]);
    const saved = await state();
    assert.equal(saved.journal.length, before.journal.length + 3);
    assert.equal(saved.head[0]!.lastMessageSequence, before.head[0]!.lastMessageSequence + 1n);
    await repository.finish(claim, "failed", "TEST_END");
  });
  await t.test(
    "native commits persist only deltas, reuse loaded history and leave empty steering untouched",
    async () => {
      const queries: string[] = [];
      const measured = createRunService(
        drizzle(pool, { schema, logger: { logQuery: (query) => queries.push(query) } }),
      );
      const conversation = await newConversation();
      const claim = claimOf((await repository.prepare(conversation.id, "incremental-worker"))!);
      const before = (await db.select().from(runs).where(eq(runs.id, claim.id)))[0]!;
      const context = new Context("session");
      await context.plugin(postgresSessionPlugin(measured, claim));
      await context.ready();
      try {
        const store = context.resolve(sessionStore);
        let current = await store.load();
        queries.length = 0;
        const execution = {
          executionId: randomUUID(),
          runId: claim.id,
          stepId: "step",
          callId: "call",
          name: "read",
          input: {},
          idempotencyKey: randomUUID(),
          effects: "read" as const,
        };
        for (const entry of [
          { ...execution, dispatch: "intent" as const },
          { ...execution, dispatch: "dispatched" as const },
          {
            ...execution,
            dispatch: "dispatched" as const,
            result: {
              name: "read",
              callId: "call",
              executionId: execution.executionId,
              status: "succeeded" as const,
              value: { ok: true },
            },
          },
        ]) {
          assert.equal((await store.load()).revision, current.revision);
          current = await store.commit({ execution: entry }, current.revision);
        }
        assert.equal(queries.filter((query) => query.startsWith('insert into "session_commits"')).length, 3);
        const revision = current.revision;
        await Promise.all(
          Array.from({ length: 4 }, (_, index) =>
            commitSessionUpdate(store, {
              execution: { ...execution, executionId: randomUUID(), callId: "parallel-" + index, dispatch: "intent" },
            }),
          ),
        );
        current = await store.load();
        assert.equal(current.revision, revision + 4);
        assert.equal(
          queries.filter((query) => query === "rollback").length,
          0,
          "owned parallel updates do not race their revisions",
        );
        assert.ok(
          queries
            .filter((query) => query.startsWith('update "runs"'))
            .every((query) => !/"(checkpoint|projection)" =/.test(query)),
        );
        assert.ok(
          queries
            .filter((query) => query.startsWith("select") && query.includes('from "runs"'))
            .every((query) => !query.includes('"nativeState"')),
        );
        const persisted = (await db.select().from(runs).where(eq(runs.id, claim.id)))[0]!;
        assert.deepEqual(persisted.checkpoint, before.checkpoint);
        assert.equal(persisted.checkpointRevision, before.checkpointRevision);
        const recovered = await repository.load(claim);
        assert.deepEqual(nativeSnapshot(recovered.checkpoint, recovered.revision), current);
        queries.length = 0;
        assert.deepEqual(await measured.reserveSteering(claim), []);
        assert.equal(queries.filter((query) => /^(insert|update|delete)/.test(query)).length, 0);
        assert.equal((await repository.load(claim)).revision, current.revision);
        queries.length = 0;
        await measured.watch(claim);
        assert.ok(queries.every((query) => !query.includes('"checkpoint"') && !query.includes('"projection"')));
      } finally {
        await context.dispose();
        await repository.finish(claim, "failed", "TEST_END");
      }
      assert.equal((await db.select().from(sessionCommits).where(eq(sessionCommits.runId, claim.id))).length, 0);
    },
  );
  await t.test("job host starts independent jobs up to its capacity and drains them on shutdown", async () => {
    const ids = Array.from({ length: 3 }, () => randomUUID());
    for (const [index, id] of ids.entries())
      await enqueueJob({ db, job: { kind: "conversation.context-compact", aggregateId: id, payload: { index } } });
    const releases: (() => void)[] = [];
    const gates = ids.map(
      (_, index) =>
        new Promise<void>((resolve) => {
          releases[index] = resolve;
        }),
    );
    const started: number[] = [];
    let active = 0,
      maximum = 0;
    const host = createJobHost({
      db,
      workerLeaseSeconds: 30,
      pollIntervalMs: 10,
      batchLimit: 10,
      concurrency: 2,
      registry: new Map([
        [
          "conversation.context-compact",
          async (job) => {
            const index = Number(job.payload.index);
            started.push(index);
            maximum = Math.max(maximum, ++active);
            try {
              await gates[index];
            } finally {
              active--;
            }
          },
        ],
      ]),
    });
    const waitFor = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 300 && !condition(); attempt++) await delay(10);
      assert.ok(condition(), "worker progress deadline");
    };
    host.start();
    try {
      await waitFor(() => started.length === 2);
      const waiting = await pool.query("select count(*)::int as count from jobs where kind=$1 and status='queued'", [
        "conversation.context-compact",
      ]);
      assert.equal(waiting.rows[0].count, 1, "only free slots may acquire a lease");
      releases[started[0]!]!();
      await waitFor(() => started.length === 3);
      assert.equal(maximum, 2);
      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await delay(20);
      assert.equal(stopped, false);
      releases.forEach((release) => release());
      await stopping;
      const completed = await pool.query("select status from jobs where aggregate_id=ANY($1::uuid[])", [ids]);
      assert.ok(completed.rows.every((row) => row.status === "succeeded"));
    } finally {
      releases.forEach((release) => release());
      await host.stop();
    }
  });
  await t.test("job handler failures are recorded and reported", async () => {
    const id = randomUUID();
    await enqueueJob({ db, job: { kind: "conversation.context-compact", aggregateId: id, payload: {} } });
    const error = new Error("injected failure");
    const reported: unknown[] = [];
    const host = createJobHost({
      db,
      workerLeaseSeconds: 30,
      pollIntervalMs: 10,
      registry: new Map([["conversation.context-compact", async () => { throw error; }]]),
      onError: (cause) => reported.push(cause),
    });
    host.start();
    try {
      for (let attempt = 0; attempt < 300 && !reported.length; attempt++) await delay(10);
      assert.deepEqual(reported, [error]);
      const result = await pool.query("select status, attempt, safe_error_code from jobs where aggregate_id=$1", [id]);
      assert.deepEqual(result.rows, [{ status: "queued", attempt: 1, safe_error_code: "Error" }]);
    } finally {
      await host.stop();
    }
  });
  await t.test("input dedupe, confirmed consumption, native pairing and snapshot/journal equivalence", async () => {
    const conversation = await newConversation();
    const input = {
      conversationId: conversation.id,
      ownerUserId: owner,
      blocks: [{ id: "text", type: "text" as const, text: "queued" }],
      mode: "next_run" as const,
      idempotencyKey: "retry-key",
    };
    const first = await conversationRepository.enqueue(input),
      second = await conversationRepository.enqueue(input);
    assert.equal(first.id, second.id);
    await assert.rejects(
      conversationRepository.enqueue({ ...input, blocks: [{ id: "text", type: "text", text: "changed" }] }),
    );
    const prepared = (await repository.prepare(conversation.id, "worker-a"))!;
    const claim = claimOf(prepared);
    assert.equal((await db.select().from(pendingInputs).where(eq(pendingInputs.runId, claim.id)))[0]?.status, "queued");
    let effects = 0;
    const tool = defineTool({
      name: "inspect",
      description: "inspect",
      inputSchema: z.object({}),
      outputSchema: z.object({ done: z.boolean() }),
      effects: "read",
      async execute(_input, context) {
        effects++;
        await context.output?.("stdout", "中文😀");
        return { done: true };
      },
    });
    const initial = await snapshot(conversation.id);
    const pinnedModel = randomUUID();
    await repository.pinModel(claim, pinnedModel);
    assert.equal((await conversationRepository.enqueue(input)).id, first.id);
    const runtime = await harness(repository, claim, tool);
    const result = await runtime.run(
      {
        id: prepared.command.kind === "start" ? prepared.command.messageId : randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Start" }],
      },
      {
        runId: claim.id,
      },
    );
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(effects, 1);
    await runtime.close();
    await repository.finish(claim, "succeeded");
    const final = await snapshot(conversation.id);
    assert.equal(final.conversation.configuration.modelId, pinnedModel);
    assert.deepEqual(
      final.messages.map((message) => message.role),
      ["user", "assistant", "tool", "assistant"],
    );
    assert.equal(final.messages[1]?.blocks[0]?.type, "thinking");
    assert.deepEqual(final.operations[0]?.stdout, { text: "中文😀", startOffset: 0, nextOffset: 4 });
    const consumed = (await db.select().from(pendingInputs).where(eq(pendingInputs.runId, claim.id)))[0]!;
    assert.equal(consumed.status, "consumed");
    assert.equal(consumed.messageId, final.messages[0]?.id);
    const events = await db
      .select()
      .from(uiEvents)
      .where(and(eq(uiEvents.conversationId, conversation.id), sql`${uiEvents.sequence}>${BigInt(initial.cursor)}`))
      .orderBy(asc(uiEvents.sequence));
    const projected = events.reduce(
      (state, row) =>
        applyEvent(
          state,
          productEventSchema.parse({
            sequence: String(row.sequence),
            runId: row.runId,
            type: row.type,
            payload: row.payload,
          }),
        ),
      initial,
    );
    assert.deepEqual(projected, final);
    const [storedConversation] = await db.select().from(conversations).where(eq(conversations.id, conversation.id));
    assert.equal(storedConversation?.metadata.latestCheckpointRunId, claim.id);
    const checkpoint = (await db.select().from(runs).where(eq(runs.id, claim.id)))[0]!.checkpoint!;
    assert.equal(nativeSnapshot(checkpoint, 1).messages.length, 4);
  });
  await t.test("job claims bind multiple kinds as one PostgreSQL array", async () => {
    await enqueueJob({ db, job: { kind: "outbox", payload: {} } });
    await enqueueJob({ db, job: { kind: "attachment.gc", payload: {} } });
    const result = await claimJobs({ db, kinds: ["outbox", "attachment.gc"], limit: 2, leaseSeconds: 30 });
    assert.equal(result.kind, "claimed");
    if (result.kind !== "claimed") return;
    assert.deepEqual(new Set(result.jobs.map((job) => job.kind)), new Set(["outbox", "attachment.gc"]));
    assert.ok(result.jobs.every((job) => job.attempt === 1 && job.status === "running"));
    assert.equal((await claimJobs({ db, kinds: [], limit: 1, leaseSeconds: 30 })).kind, "empty");
  });
  await t.test(
    "approval releases a slot, restores the same run, dedupes replies and rejects a stale worker",
    async () => {
      const conversation = await newConversation();
      const prepared = (await repository.prepare(conversation.id, "waiting-worker"))!,
        claim = claimOf(prepared);
      let effects = 0;
      const tool = defineTool({
        name: "write",
        description: "write",
        inputSchema: z.object({}),
        outputSchema: z.object({ done: z.boolean() }),
        effects: "write",
        async execute() {
          effects++;
          return { done: true };
        },
      });
      const policyFor = (active: RunClaim): import("@nnova/harness").ToolPolicy => ({
        id: "approval",
        async authorize({ context }) {
          const checkpoint = (await repository.load(active)).checkpoint;
          const prior = checkpoint.interactions.find((item) => item.callId === context.callId);
          if (prior?.response?.kind === "approval") return prior.response.decision;
          const interaction = await repository.requestInteraction(active, {
            id: "approval",
            kind: "approval",
            callId: context.callId,
            revision: 1,
            state: "pending",
            toolName: "write",
            args: {},
            risk: "write",
            allowedScopes: ["once"],
          });
          return { kind: "ask", continuationId: interaction.id };
        },
      });
      const first = await harness(repository, claim, tool, policyFor(claim));
      const waiting = await first.run(
        {
          id: prepared.command.kind === "start" ? prepared.command.messageId : randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "Start" }],
        },
        { runId: claim.id },
      );
      assert.equal(waiting.kind, "suspended");
      await repository.suspend(claim);
      await first.close();
      assert.equal(effects, 0);
      assert.equal(await repository.prepare(conversation.id, "other-worker"), null);
      const response = { kind: "approval" as const, decision: "allow" as const, scope: "once" as const };
      const resolved = await repository.respond(claim.id, "approval", owner, 1, response);
      assert.deepEqual(await repository.respond(claim.id, "approval", owner, 1, response), resolved);
      await assert.rejects(repository.respond(claim.id, "approval", owner, 1, { ...response, decision: "deny" }));
      await assert.rejects(repository.respond(claim.id, "approval", owner, 1, { ...response, scope: "session" }));
      const preparedAgain = (await repository.prepare(conversation.id, "resumed-worker"))!,
        nextClaim = claimOf(preparedAgain);
      assert.equal(nextClaim.id, claim.id);
      assert.ok(nextClaim.fence > claim.fence);
      const latest = await repository.load(nextClaim);
      await assert.rejects(repository.commit(nextClaim, latest.revision - 1, latest.checkpoint, []), {
        code: "CONFLICT",
      });
      await assert.rejects(
        repository.publish(claim, { runId: claim.id, type: "usage.changed", payload: { usage: { inputTokens: 999 } } }),
      );
      const second = await harness(repository, nextClaim, tool, policyFor(nextClaim));
      const checkpoint = (await repository.load(nextClaim)).checkpoint;
      const continuation = checkpoint.continuation as { continuationId: string };
      const result = await second.resume({
        runId: nextClaim.id,
        continuationId: continuation.continuationId,
        input: null,
      });
      assert.equal(result.status, "succeeded", JSON.stringify(result));
      assert.equal(effects, 1);
      await second.close();
      await repository.finish(nextClaim, "succeeded");
      assert.equal((await snapshot(conversation.id)).messages.filter((message) => message.role === "user").length, 1);
      assert.equal((await repository.cancel(claim.id, owner)).state, "succeeded");
    },
  );
  for (const failAt of ["pre_dispatch", "intent", "result"] as const)
    await t.test("lost " + failAt + " confirmation is recovered without duplicate effects", async () => {
      let armed = true;
      const faulty = {
        ...repository,
        async commitSession(claim: RunClaim, revision: number, next: SessionSnapshot, batch: SessionCommit) {
          const result = await repository.commitSession(claim, revision, next, batch);
          const execution = batch.execution;
          let shouldFault = false;
          if (execution) {
            if (failAt === "intent") shouldFault = execution.dispatch === "dispatched" && !execution.result;
            else if (failAt === "pre_dispatch") shouldFault = !execution.result;
            else shouldFault = Boolean(execution.result);
          }
          if (armed && shouldFault) {
            armed = false;
            throw new Error("SIMULATED_PROCESS_LOSS");
          }
          return result;
        },
      };
      const conversation = await newConversation();
      const prepared = (await faulty.prepare(conversation.id, "first-worker"))!,
        claim = claimOf(prepared);
      let effects = 0;
      const tool = defineTool({
        name: "effect",
        description: "effect",
        inputSchema: z.object({}),
        outputSchema: z.object({ done: z.boolean() }),
        effects: "write",
        async execute() {
          effects++;
          return { done: true };
        },
      });
      const first = await harness(faulty, claim, tool);
      await first.run(
        {
          id: prepared.command.kind === "start" ? prepared.command.messageId : randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "Start" }],
        },
        { runId: claim.id },
      );
      await first.close();
      await db
        .update(runs)
        .set({ leaseUntil: new Date(0) })
        .where(eq(runs.id, claim.id));
      const again = (await repository.prepare(conversation.id, "replacement"))!,
        nextClaim = claimOf(again);
      const checkpoint = (await repository.load(nextClaim)).checkpoint;
      const second = await harness(repository, nextClaim, tool);
      const result = await second.resume({
        runId: nextClaim.id,
        continuationId: (checkpoint.continuation as { continuationId: string }).continuationId,
        input: null,
      });
      await second.close();
      assert.equal(effects, failAt === "intent" ? 0 : 1);
      if (failAt === "intent") {
        assert.equal(result.status, "failed");
        assert.equal(result.toolCalls[0]?.outcome, "unknown");
        await repository.finish(nextClaim, "failed");
        assert.equal((await snapshot(conversation.id)).run?.state, "cancelled_unconfirmed");
        const runnerId = randomUUID();
        const binding = {
          id: randomUUID(),
          revision: 1,
          runnerId,
          workspaceId: "same-workspace",
          canonicalCwd: ".",
          instructions: {},
        };
        const original = (await db.select().from(conversations).where(eq(conversations.id, conversation.id)))[0]!;
        await db
          .update(conversations)
          .set({ metadata: { ...original.metadata, binding } })
          .where(eq(conversations.id, conversation.id));
        const another = await conversationRepository.create({
          ownerUserId: owner,
          mode: "chat",
          projectId: null,
          title: "Other binding",
          metadata: {
            configuration: { backendId: "nova", modelId: null, mode: "build" },
            binding: { ...binding, id: randomUUID(), revision: 2 },
          },
          initialInput: { blocks: [{ id: "text", type: "text", text: "Retry elsewhere" }] },
        });
        const next = await repository.prepare(another.id, "another-worker");
        assert.ok(next, "an unknown effect in another conversation must not block the run");
        const nextClaim = claimOf(next);
        let reads = 0;
        const read = defineTool({
          name: "read",
          description: "read",
          inputSchema: z.object({}),
          outputSchema: z.object({ done: z.boolean() }),
          effects: "read",
          async execute() { reads++; return { done: true }; },
        });
        const reader = await harness(repository, nextClaim, read);
        const input = {
          id: next.command.kind === "start" ? next.command.messageId : randomUUID(),
          role: "user" as const,
          parts: [{ type: "text" as const, text: "Read only" }],
        };
        try {
          const readResult = await reader.run(input, { runId: nextClaim.id });
          assert.equal(readResult.status, "succeeded");
          assert.equal(reads, 1);
        } finally {
          await reader.close();
        }
        await repository.finish(nextClaim, "succeeded");

        const writeConversation = await conversationRepository.create({
          ownerUserId: owner, mode: "chat", projectId: null, title: "Blocked write",
          metadata: { configuration: { backendId: "nova", modelId: null, mode: "build" }, binding },
          initialInput: { blocks: [{ id: "text", type: "text", text: "Attempt a write" }] },
        });
        const writeRun = await repository.prepare(writeConversation.id, "write-worker");
        assert.ok(writeRun);
        const writeClaim = claimOf(writeRun);
        const writer = await harness(repository, writeClaim, tool);
        try {
          const writeResult = await writer.run({
            id: writeRun.command.kind === "start" ? writeRun.command.messageId : randomUUID(),
            role: "user", parts: [{ type: "text", text: "Attempt a write" }],
          }, { runId: writeClaim.id });
          assert.equal(effects, 0, "the write must not be dispatched");
          assert.equal(writeResult.toolCalls[0]?.error?.code, "NOT_DISPATCHED");
        } finally {
          await writer.close();
        }
        await repository.finish(writeClaim, "succeeded");
      } else {
        assert.equal(result.status, "succeeded", JSON.stringify(result));
        await repository.finish(nextClaim, "succeeded");
      }
    });
  await t.test("a second adapter owns a native session reference and uses the same API and projection", async () => {
    const backend = "reference-test";
    runtimeAdapters.set(backend, {
      capabilities: {
        tools: false,
        approval: false,
        question: false,
        steering: false,
        resume: true,
        compact: false,
        images: false,
        files: false,
      },
      create() {
        return {
          async execute(command, context) {
            assert.equal(command.kind, "start");
            if (command.kind !== "start") throw new Error("Unexpected recovery");
            const at = new Date().toISOString();
            const user: Message = {
              id: command.messageId,
              runId: context.runId,
              sequence: "0",
              role: "user",
              state: "completed",
              blocks: command.input.blocks,
              createdAt: at,
            };
            const answer: Message = {
              id: randomUUID(),
              runId: context.runId,
              sequence: "0",
              role: "assistant",
              state: "completed",
              blocks: [
                {
                  id: "reference",
                  type: "custom",
                  name: "external.answer",
                  data: { value: 1 },
                  fallback: "External answer",
                },
              ],
              createdAt: at,
              source: { agentId: "external-agent" },
            };
            await context.commit({
              checkpoint: {
                ...context.checkpoint,
                nativeState: { sessionRef: "external-session" },
                outcome: { kind: "completed", state: "succeeded" },
              },
              events: [
                { runId: context.runId, type: "message.committed", payload: { message: user } },
                { runId: context.runId, type: "message.committed", payload: { message: answer } },
              ],
              consumedInputIds: context.checkpoint.reservedInputs.map((input) => input.id),
            });
            return { kind: "completed", state: "succeeded" };
          },
          async dispose() {},
          async cancel() {
            return "confirmed";
          },
        };
      },
    });
    try {
      const conversation = await conversationRepository.create({
        ownerUserId: owner,
        mode: "chat",
        projectId: null,
        title: "Other adapter",
        metadata: { configuration: { backendId: backend, modelId: null, mode: "build" } },
        initialInput: { blocks: [{ id: "text", type: "text", text: "Use external session" }] },
      });
      const executor = new ConversationExecutor({
        eventRetention,
        db,
        models: {} as never,
        remotes: {} as never,
        runners: {} as never,
        uploads: disabledUploadStorage(),
        logger: createAppLogger({ NODE_ENV: "test", LOG_LEVEL: "silent", LOG_DIR: "logs", ROLE: "worker" }),
      });
      await executor.handle({ aggregateId: conversation.id } as never);
      await executor.close();
      const view = await snapshot(conversation.id);
      assert.equal(view.run?.state, "succeeded");
      assert.equal(view.messages.length, 2);
      assert.equal(view.messages[1]?.source?.agentId, "external-agent");
      assert.equal(view.capabilities.tools, false);
      const [run] = await db.select().from(runs).where(eq(runs.id, view.run!.id));
      assert.deepEqual(run?.checkpoint?.nativeState, { sessionRef: "external-session" });
    } finally {
      runtimeAdapters.delete(backend);
    }
  });
  await t.test(
    "Nova HTTP/SSE keeps Runner platform, intermediate messages, thinking, real usage and native history across turns",
    async (httpTest) => {
      const requests: Record<string, unknown>[] = [];
      let upstreamStatus = 200;
      let remainingToolSteps = 0;
      let duplicateToolBatch = false;
      const upstream = createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const input = JSON.parse(raw);
        requests.push(input);
        if (upstreamStatus !== 200) {
          response.writeHead(upstreamStatus, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Do not expose upstream details" } }));
          return;
        }
        const toolResult = input.messages.some((message: { role: string }) => message.role === "tool");
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (input.tool_choice === "none") {
          response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: "预算耗尽，已保存进度，任务尚未完成。" }, finish_reason: "stop" }] }) + '\n\ndata: [DONE]\n\n');
          return;
        }
        if (!input.tools?.length) {
          response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: "请描述你负责的接口。" }, finish_reason: "stop" }] }) + '\n\ndata: [DONE]\n\n');
          return;
        }
        if (!toolResult || remainingToolSteps > 0) {
          let callId = "upstream-call";
          if (remainingToolSteps > 0) {
            callId = "budget-call-" + remainingToolSteps;
            remainingToolSteps--;
          }
          response.write(
            "data: " +
              JSON.stringify({
                choices: [{ delta: { reasoning_content: "先确认约束", content: "先列计划" }, finish_reason: null }],
              }) +
              "\n\n",
          );
          if (callId === "upstream-call") await delay(80);
          response.write(
            "data: " +
              JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: Array.from({ length: duplicateToolBatch ? 4 : 1 }, (_, index) => (
                        {
                          index,
                          id: duplicateToolBatch ? `${callId}-${index}` : callId,
                          type: "function",
                          function: {
                            name: "todo_write",
                            arguments: JSON.stringify({
                              items: [{ id: "todo", text: "检查结果", status: "completed" }],
                            }),
                          },
                        }
                      )),
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              }) +
              "\n\n",
          );
          duplicateToolBatch = false;
        } else
          response.write(
            "data: " + JSON.stringify({ choices: [{ delta: { content: "完成😀" }, finish_reason: "stop" }] }) + "\n\n",
          );
        response.end(
          "data: " +
            JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } }) +
            "\n\ndata: [DONE]\n\n",
        );
      });
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      const address = upstream.address() as { port: number };
      const key = "1".repeat(64);
      const [provider] = await db
        .insert(modelProviders)
        .values({
          protocol: "openai",
          name: "test",
          baseUrl: "http://127.0.0.1:" + address.port + "/v1",
          credentialCiphertext: createCredentialCipher(key).encrypt("test-key"),
          credentialMasked: "test",
          enabled: true,
          isPublic: true,
        })
        .returning();
      const [modelEntry] = await db
        .insert(modelConfigs)
        .values({
          publicName: "test-nova",
          providerId: provider!.id,
          upstreamName: "test",
          contextWindow: "128000",
          maxOutput: "8192",
          enabled: true,
        })
        .returning();
      const app = await buildApp(
        loadConfig({
          DATABASE_URL: target.toString(),
          LOG_LEVEL: "silent",
          ROLE: "api",
          AUTH_MODE: "dev",
          MODEL_CONFIG_ENCRYPTION_KEY: key,
        }),
      );
      await app.listen({ port: 0, host: "127.0.0.1" });
      const executor = new ConversationExecutor({
        eventRetention,
        db,
        models: createUserModelProfilesService(app),
        remotes: createRemoteService(app),
        runners: app.runnerConnections,
        uploads: disabledUploadStorage(),
        logger: app.log,
      });
      const headers = { authorization: "Bearer " + DEV_MOCK_ACCESS_TOKEN };
      let host: ReturnType<typeof createJobHost> | undefined;
      try {
        const tokens = createRunnerTokenRepository(db);
        const directory = createRunnerRepository(db);
        const tokenService = new RunnerTokenService(
          tokens,
          createScope(db).serviceTransaction({ repository: tokens }),
          key,
        );
        const token = await tokenService.create({ ownerUserId: DEV_LOCAL_USER_ID, capabilities: ["exec"] });
        const registration = new RunnerRegistrationService(
          tokens,
          createScope(db).serviceTransaction({ runners: directory, tokens }),
        );
        const deviceId = randomUUID();
        const registerRunner = async (platform: string) => {
          const identity: RunnerSession["identity"] = {
            runnerId: deviceId,
            bootId: randomUUID(),
            protocolVersion: 2,
            version: "test",
            platform,
            capabilities: ["exec"],
            workspaces: [{ workspaceId: "workspace", displayName: "Test", permission: "READ_WRITE" }],
            maxConcurrency: 1,
          };
          const registered = await registration.register(token.secret, identity);
          assert.ok(registered);
          app.runnerConnections.add(registered.runner.id, DEV_LOCAL_USER_ID, token.row.id, {
            identity,
            bootId: identity.bootId,
            connectionEpoch: randomUUID(),
            connected: true,
            workspaces: identity.workspaces,
            createToolContext() {
              throw new Error("Unexpected Runner tool call");
            },
            onStatus: () => () => undefined,
            cancel: async () => ({ ok: true, value: undefined }),
            query: async () => ({
              ok: false,
              error: { code: "NOT_FOUND", message: "Not found", outcome: "known" },
            }),
            close: async () => undefined,
          });
          return registered.runner.id;
        };
        const runnerId = await registerRunner("windows");
        const [project] = await db
          .insert(projects)
          .values({ ownerUserId: DEV_LOCAL_USER_ID, name: "Runner prompt" })
          .returning();
        assert.ok(project);
        const bound = await app.inject({
          method: "PUT",
          url: "/api/projects/" + project.id + "/binding",
          headers,
          payload: { runnerId, workspaceId: "workspace", canonicalCwd: ".", expectedRevision: 0 },
        });
        assert.equal(bound.statusCode, 200, bound.body);
        const created = await app.inject({
          method: "POST",
          url: "/api/conversations/",
          headers,
          payload: {
            mode: "project",
            projectId: project.id,
            configuration: { backendId: "nova", modelId: null, mode: "build" },
            initialInput: { blocks: [{ id: "text", type: "text", text: "第一轮" }] },
          },
        });
        assert.equal(created.statusCode, 200, created.body);
        const id = created.json().data.id as string;
        const before = (
          await app.inject({ method: "GET", url: "/api/conversations/" + id + "/snapshot", headers })
        ).json().data;
        const endpoint = "http://127.0.0.1:" + (app.server.address() as { port: number }).port;
        const stream = await fetch(endpoint + "/api/conversations/" + id + "/events?cursor=" + before.cursor, {
          headers: { ...headers, "last-event-id": id + ":" + before.cursor },
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(stream.status, 200);
        const reader = stream.body!.getReader();
        host = createJobHost({
          db,
          workerLeaseSeconds: 30,
          pollIntervalMs: 10,
          registry: new Map([
            ["run.wake", (job) => (job.aggregateId === id ? executor.handle(job) : Promise.resolve())],
          ]),
        });
        host.start();
        const events: import("@nova/agent-ui-contracts").ProductEvent[] = [];
        let buffer = "",
          done = false;
        while (!done) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          buffer += new TextDecoder().decode(chunk.value);
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const json = frame.split("\n").find((line) => line.startsWith("data: "));
            if (!json) continue;
            const event = productEventSchema.parse(JSON.parse(json.slice(6)));
            events.push(event);
            assert.ok(frame.includes("id: " + id + ":" + event.sequence));
            if (event.type === "run.changed" && event.payload.run.state === "succeeded") {
              done = true;
              break;
            }
          }
        }
        await reader.cancel();
        const final = (
          await app.inject({ method: "GET", url: "/api/conversations/" + id + "/snapshot", headers })
        ).json().data;
        const { binding: _beforeBinding, ...initialCore } = before;
        const { binding: _finalBinding, ...finalCore } = final;
        assert.deepEqual(events.reduce(applyEvent, snapshotSchema.parse(initialCore)), snapshotSchema.parse(finalCore));
        assert.equal(final.messages.length, 4);
        assert.equal(final.conversation.configuration.modelId, modelEntry!.id);
        assert.ok(events.some((event) => event.type === "block.upsert" && event.payload.block.type === "thinking"));
        assert.deepEqual(final.usage, { inputTokens: 40, outputTokens: 10 });
        assert.equal(final.plan[0]?.text, "检查结果");
        assert.equal(requests.length, 2);
        const providerMessagesSchema = z
          .object({
            role: z.string(),
            content: z.string().nullable().optional(),
            tool_call_id: z.string().optional(),
            reasoning_content: z.string().optional(),
          })
          .array();
        await httpTest.test("the first model request includes the registered Runner operating system", () => {
          const firstMessages = providerMessagesSchema.parse(requests[0]!.messages);
          assert.equal(firstMessages[0]?.role, "system");
          assert.ok(firstMessages[0]?.content);
          assert.match(firstMessages[0].content, /Runner operating system: "windows"/);
          assert.match(firstMessages[0].content, /bash tool runs a program directly without a shell/);
        });
        // A new registration must replace the previous platform before the next model request.
        assert.equal(await registerRunner("linux"), runnerId);
        const followup = await app.inject({
          method: "POST",
          url: "/api/conversations/" + id + "/inputs",
          headers,
          payload: { blocks: [{ id: "text", type: "text", text: "第二轮" }], mode: "next_run" },
        });
        assert.equal(followup.statusCode, 200, followup.body);
        const waitForRun = async (state: "succeeded" | "failed" | "budget_exhausted" | "waiting", maxAttempts = 200) => {
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const view = (
              await app.inject({ method: "GET", url: "/api/conversations/" + id + "/snapshot", headers })
            ).json().data;
            if (view.pendingInputs.length === 0 && view.run?.state === state) return view;
            await delay(25);
          }
          assert.fail("Queued input did not reach " + state);
        };
        await waitForRun("succeeded");
        assert.equal(requests.length, 3);
        const continued = providerMessagesSchema.parse(requests[2]!.messages);
        assert.ok(continued.some((message) => message.role === "tool" && message.tool_call_id === "upstream-call"));
        assert.ok(continued.some((message) => message.reasoning_content === "先确认约束"));
        await httpTest.test("a new Runner registration refreshes the operating system in follow-up requests", () => {
          assert.ok(continued[0]?.content);
          assert.match(continued[0].content, /Runner operating system: "linux"/);
          assert.doesNotMatch(continued[0].content, /Runner operating system: "windows"/);
        });
        upstreamStatus = 429;
        const limited = await app.inject({
          method: "POST",
          url: "/api/conversations/" + id + "/inputs",
          headers,
          payload: { blocks: [{ id: "text", type: "text", text: "限流检查" }], mode: "next_run" },
        });
        assert.equal(limited.statusCode, 200, limited.body);
        const limitedView = await waitForRun("failed");
        assert.equal(limitedView.run.reason, "MODEL_RATE_LIMITED");
        // 提供商原文随失败消息的错误块一起交付, 不再只停留在运行摘要里.
        const limitedMessage = limitedView.messages.find((message: { state: string }) => message.state === "failed");
        assert.ok(limitedMessage, "failed assistant message is committed");
        const limitedError = limitedMessage!.blocks.find((block: { type: string }) => block.type === "error");
        assert.equal(limitedError?.type, "error");
        assert.deepEqual(limitedError!.error, { code: "MODEL_RATE_LIMITED", message: "Do not expose upstream details" });
        await httpTest.test("workspace tasks are not limited to 64 model steps or tool executions", async () => {
          upstreamStatus = 200;
          remainingToolSteps = 65;
          const beforeRequests = requests.length;
          const continued = await app.inject({
            method: "POST",
            url: "/api/conversations/" + id + "/inputs",
            headers,
            payload: { blocks: [{ id: "text", type: "text", text: "继续处理长任务" }], mode: "next_run" },
          });
          assert.equal(continued.statusCode, 200, continued.body);
          const view = await waitForRun("succeeded", 800);
          assert.equal(remainingToolSteps, 0);
          assert.equal(requests.length - beforeRequests, 66);
          assert.equal(view.run.reason, undefined);
        });
        await httpTest.test("explicit budgets persist a separate terminal state and saved progress continues in a new run", async () => {
          remainingToolSteps = 2;
          const budgeted = await app.inject({ method: "POST", url: "/api/conversations/" + id + "/inputs", headers,
            payload: { blocks: [{ id: "text", type: "text", text: "使用一步工作预算" }], mode: "next_run",
              configuration: { backendId: "nova", modelId: modelEntry!.id, mode: "build", budget: { maxSteps: 1 } } } });
          assert.equal(budgeted.statusCode, 200, budgeted.body);
          const stopped = await waitForRun("budget_exhausted");
          assert.equal(stopped.run.reason, "STEP_LIMIT");
          assert.equal(stopped.conversation.configuration.budget.maxSteps, 1);
          assert.ok(JSON.stringify(stopped.messages).includes("预算耗尽，已保存进度"));
          const [persisted] = await db.select().from(runs).where(eq(runs.id, stopped.run.id));
          assert.equal(persisted?.state, "budget_exhausted");
          remainingToolSteps = 0;
          const continued = await app.inject({ method: "POST", url: "/api/conversations/" + id + "/inputs", headers,
            payload: { blocks: [{ id: "text", type: "text", text: "继续" }], mode: "next_run" } });
          assert.equal(continued.statusCode, 200, continued.body);
          const finished = await waitForRun("succeeded");
          assert.notEqual(finished.run.id, stopped.run.id);
          assert.ok(JSON.stringify(requests.at(-1)).includes("预算耗尽，已保存进度"));
        });
        await httpTest.test("repeated read calls ask once in plan mode and resume without replaying completed tools", async () => {
          remainingToolSteps = 1;
          duplicateToolBatch = true;
          const submitted = await app.inject({ method: "POST", url: "/api/conversations/" + id + "/inputs", headers,
            payload: { blocks: [{ id: "text", type: "text", text: "重复调用确认" }], mode: "next_run",
              configuration: { backendId: "nova", modelId: modelEntry!.id, mode: "plan" } } });
          assert.equal(submitted.statusCode, 200, submitted.body);
          const waiting = await waitForRun("waiting");
          assert.equal(waiting.capabilities.approval, true);
          const pending = waiting.interactions.filter((interaction: { state: string }) => interaction.state === "pending");
          assert.equal(pending.length, 1);
          const decision = pending[0];
          assert.match(decision.message, /同一条助手消息.*4 次/);
          assert.equal(decision.risk, "read");
          assert.deepEqual(decision.allowedScopes, ["once"]);
          const [paused] = await db.select().from(runs).where(eq(runs.id, waiting.run.id));
          const pausedCheckpoint = await readCheckpoint(db, paused!);
          assert.equal(pausedCheckpoint?.executions.filter((entry) => entry.dispatch === "dispatched").length, 2);
          const url = "/api/runs/" + waiting.run.id + "/interactions/" + decision.id + "/respond";
          const invalidScope = await app.inject({ method: "POST", url, headers,
            payload: { expectedRevision: decision.revision, response: { kind: "approval", decision: "allow", scope: "session" } } });
          assert.equal(invalidScope.statusCode, 400, invalidScope.body);
          const approved = await app.inject({ method: "POST", url, headers,
            payload: { expectedRevision: decision.revision, response: { kind: "approval", decision: "allow", scope: "once" } } });
          assert.equal(approved.statusCode, 200, approved.body);
          const finished = await waitForRun("succeeded");
          assert.equal(finished.run.id, waiting.run.id);
          assert.equal(finished.operations.length, 4);
          assert.equal(finished.interactions.filter((item: { state: string }) => item.state === "pending").length, 0);
        });
        const config = (await app.inject({ method: "GET", url: "/api/config", headers })).json().data;
        const catalog = await app.inject({ method: "GET", url: "/admin/model-config/models", headers });
        assert.equal(catalog.statusCode, 200, catalog.body);
        assert.ok(Array.isArray(catalog.json().data));
        assert.equal("contractVersion" in config, false);
        assert.equal(config.capabilities.uploads, false);
        await httpTest.test("career chats pin profile and skill snapshots, recover and wait for each real answer", async () => {
          upstreamStatus = 200;
          const skill = { id: careerCoachSkill.id, version: careerCoachSkill.version };
          const configuration = { backendId: "nova", modelId: modelEntry!.id, mode: "plan", agentProfile: CHAT_AGENT_PROFILE };
          const blocks = [{ id: "text", type: "text", text: "项目是团队做的，我只负责接口。请模拟面试。" }];
          const createdCoach = await app.inject({ method: "POST", url: "/api/conversations/", headers,
            payload: { mode: "chat", configuration, initialInput: { blocks, skill } } });
          assert.equal(createdCoach.statusCode, 200, createdCoach.body);
          const coachId: string = createdCoach.json().data.id;
          const baseUrl = "/api/conversations/" + coachId;
          const readCoach = async () => (await app.inject({ method: "GET", url: baseUrl + "/snapshot", headers })).json().data;
          const [queued] = await db.select().from(pendingInputs).where(eq(pendingInputs.conversationId, coachId));
          assert.ok(queued?.payload.execution?.agentProfile && queued.payload.execution.skill);
          const execution = { agentProfile: { ...queued.payload.execution.agentProfile,
            systemPrompt: queued.payload.execution.agentProfile.systemPrompt + "\nPinned profile marker" },
            skill: { ...queued.payload.execution.skill, content: queued.payload.execution.skill.content + "\nPinned skill marker" } };
          await db.update(pendingInputs).set({ payload: { ...queued.payload, execution } }).where(eq(pendingInputs.id, queued.id));
          const prepared = await repository.prepare(coachId, "crashed-worker");
          assert.ok(prepared?.run.checkpoint);
          assert.deepEqual(prepared.run.checkpoint.execution, execution);
          await db.update(runs).set({ leaseUntil: new Date(0) }).where(eq(runs.id, prepared.run.id));
          const requestOffset = requests.length;
          const runOnce = async () => {
            const now = new Date();
            await executor.handle({ jobId: randomUUID(), kind: "run.wake", aggregateId: coachId,
              dedupeKey: null, payload: {}, schemaVersion: 1, availableAt: now, attempt: 0, maxAttempts: 3,
              leaseUntil: null, status: "running", safeErrorCode: null, createdAt: now, updatedAt: now });
            const view = await readCoach();
            assert.equal(view.run?.state, "succeeded");
            assert.equal(view.pendingInputs.length, 0);
            assert.equal(view.conversation.activeRunId, undefined);
            assert.equal(view.capabilities.tools, false);
            assert.equal(view.capabilities.steering, false);
            return view;
          };
          const first = await runOnce();
          assert.equal(first.messages[0].skill.version, skill.version);
          assert.ok(!JSON.stringify(first).includes("Pinned skill marker"));
          const firstRequest = requests[requestOffset]!;
          assert.equal(z.array(z.unknown()).optional().parse(firstRequest.tools)?.length ?? 0, 0);
          const firstMessages = providerMessagesSchema.parse(firstRequest.messages);
          assert.match(firstMessages[0]!.content!, /Pinned profile marker/);
          assert.doesNotMatch(firstMessages[0]!.content!, /PLAN MODE|BUILD MODE|Runner operating system|finish_goal|spec_read|workspace/);
          assert.ok(firstMessages.some((message) => message.content?.includes("Pinned skill marker")));
          for (const payload of [
            { blocks, skill: { ...skill, version: "9.0.0" } }, { blocks, skill, mode: "steer" },
            { blocks, configuration: { ...configuration, agentProfile: undefined } },
            { blocks, configuration: { ...configuration, mode: "build" } },
            { blocks, goal: { objective: "自动代答" } },
          ]) {
            const invalid = await app.inject({ method: "POST", url: baseUrl + "/inputs", headers, payload });
            assert.ok(invalid.statusCode >= 400 && invalid.statusCode < 500, invalid.body);
          }
          for (const payload of [
            { blocks: [{ id: "text", type: "text", text: "我只设计了接口协议。" }], skill },
            { blocks: [{ id: "text", type: "text", text: "结束面试，只依据实际问答复盘。" }], skill },
            { blocks: [{ id: "text", type: "text", text: "现在普通聊天" }] },
          ]) {
            const accepted = await app.inject({ method: "POST", url: baseUrl + "/inputs", headers, payload });
            assert.equal(accepted.statusCode, 200, accepted.body);
            await runOnce();
          }
          const finalCoach = await readCoach();
          const users = finalCoach.messages.filter((message: Message) => message.role === "user");
          assert.deepEqual(users.map((message: Message) => message.skill?.version), ["1.0.0", "1.0.0", "1.0.0", undefined]);
          const ordinary = providerMessagesSchema.parse(requests.at(-1)!.messages);
          assert.ok(!ordinary.some((message) => message.content?.includes("# 求职教练")));
          const codingInjection = await app.inject({ method: "POST", url: "/api/conversations/" + id + "/inputs", headers, payload: { blocks, skill } });
          assert.equal(codingInjection.statusCode, 409);
          const profileSwitch = await app.inject({ method: "POST", url: "/api/conversations/" + id + "/inputs", headers, payload: { blocks, configuration } });
          assert.equal(profileSwitch.statusCode, 409);
          const catalog = await app.inject({ method: "GET", url: "/api/skills", headers });
          assert.equal(catalog.statusCode, 200, catalog.body);
          assert.deepEqual(catalog.json().data.items.map((entry: { id: string; version: string }) => ({ id: entry.id, version: entry.version })), [skill]);
          assert.ok(!catalog.body.includes("# 求职教练"));
        });
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/api/attachments/uploads",
              headers,
              payload: { filename: "image.png", mime: "image/png", size: 11 },
            })
          ).statusCode,
          409,
        );
      } finally {
        host?.stop();
        await executor.close();
        await app.close();
        await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
      }
    },
  );
  await t.test("steering is atomic and unconfirmed reserved inputs are rejected at termination", async () => {
    const conversation = await newConversation();
    const prepared = (await repository.prepare(conversation.id, "input-worker"))!,
      claim = claimOf(prepared);
    const queued = await conversationRepository.enqueue({
      conversationId: conversation.id,
      ownerUserId: owner,
      blocks: [{ id: "text", type: "text", text: "Change direction" }],
      mode: "next_run",
      idempotencyKey: "steer-input",
    });
    const request = { conversationId: conversation.id, ownerUserId: owner, inputId: queued.id };
    assert.equal((await conversationRepository.steerPendingInput(request)).id, queued.id);
    assert.equal((await conversationRepository.steerPendingInput(request)).id, queued.id);
    assert.equal(
      (await db.select().from(pendingInputs).where(eq(pendingInputs.conversationId, conversation.id))).length,
      2,
    );
    const reserved = await repository.reserveSteering(claim);
    assert.equal(reserved.length, 1);
    assert.equal((await db.select().from(pendingInputs).where(eq(pendingInputs.id, queued.id)))[0]?.status, "queued");
    await assert.rejects(conversationRepository.removePendingInput(request));
    await repository.finish(claim, "failed", "TEST_STOP");
    const view = await snapshot(conversation.id);
    assert.equal(view.pendingInputs.length, 0);
    const rejected = await db.select().from(pendingInputs).where(eq(pendingInputs.conversationId, conversation.id));
    assert.ok(rejected.every((input) => input.status === "rejected"));
  });
  await t.test("persistence adapters reject missing transactions and weak snapshot contexts", async () => {
    const conversation = await newConversation();
    await assert.rejects(
      rawConversations.create({ ownerUserId: owner, mode: "chat", projectId: null, title: "unsafe", metadata: {} }),
      { code: "TRANSACTION_REQUIRED" },
    );
    await assert.rejects(createRunRepository(db).prepare(conversation.id, "unsafe-worker"), {
      code: "TRANSACTION_REQUIRED",
    });
    await assert.rejects(
      scopedUow.transaction((tx) => rawConversations.tx(tx).snapshot(conversation.id, owner)),
      { code: "TRANSACTION_OPTIONS_MISMATCH" },
    );
    const view = await conversationRepository.snapshot(conversation.id, owner);
    assert.equal(view.conversation.id, conversation.id);
  });

  await t.test("model commands roll back final-read failures and provider cascades as one transaction", async () => {
    const catalog = createModelConfigRepository(db);
    const key = "ab".repeat(32);
    const makeAdmin = (repository: typeof catalog) =>
      createScope(db).get(
        defineService(
          { repository },
          ({ repository, transaction }) => new ModelConfigService(repository, key, transaction),
        ),
      );
    const adminService = makeAdmin(catalog);
    const principal = { identityId: "transaction-admin", localUserId: owner, roles: ["admin"] };
    const provider = await adminService.createProvider(
      {
        protocol: "openai",
        name: "Atomic provider",
        baseUrl: "https://example.test/v1",
        credential: "test-credential",
        enabled: true,
        isPublic: false,
      },
      principal,
    );
    const input = createModelBodySchema.parse({
      publicName: "atomic-" + randomUUID(),
      providerId: provider.id,
      upstreamName: "test",
      contextWindow: 16000,
      maxOutput: 1000,
      enabled: true,
    });
    const fault = new Error("Injected after model persistence");
    const failedRead = createScope(db).get(
      defineService({ catalog }, ({ catalog }) => ({
        ...catalog,
        async findModel() {
          throw fault;
        },
      })),
    );
    await assert.rejects(makeAdmin(failedRead).createModel(input), (error) => error === fault);
    assert.equal((await db.select().from(modelConfigs).where(eq(modelConfigs.publicName, input.publicName))).length, 0);
    const saved = await adminService.createModel(input);
    const failedCascade = createScope(db).get(
      defineService({ catalog }, ({ catalog }) => ({
        ...catalog,
        async updateProvider(...args: Parameters<typeof catalog.updateProvider>) {
          await catalog.updateProvider(...args);
          throw fault;
        },
      })),
    );
    await assert.rejects(
      makeAdmin(failedCascade).updateProvider(provider.id, { enabled: false }, principal),
      (error) => error === fault,
    );
    assert.equal((await catalog.findProvider(provider.id))?.enabled, true);
    assert.equal((await catalog.findModel(saved.id))?.enabled, true);
    await adminService.updateProvider(provider.id, { enabled: false }, principal);
    assert.equal((await catalog.findProvider(provider.id))?.enabled, false);
    assert.equal((await catalog.findModel(saved.id))?.enabled, false);
  });

  await t.test("scoped services share real transactions and caught nested errors roll back every module", async () => {
    const tokenOwner = randomUUID();
    const tokens = createRunnerTokenRepository(db);
    const projectsRepo = createProjectRepository(db);
    const scope = createScope(db);
    const child = scope.get(
      defineService(
        { repository: tokens },
        ({ repository, transaction }) => new RunnerTokenService(repository, transaction, "ab".repeat(32)),
      ),
    );
    const original = await child.create({ ownerUserId: tokenOwner, capabilities: [] });
    const fault = new Error("after scoped rotation");
    const parent = scope.get(
      defineService({ child, projects: projectsRepo }, ({ transaction }) => ({
        rotate: (fail: boolean) =>
          transaction(async ({ child, projects }) => {
            await projects.create({ ownerUserId: tokenOwner, name: "atomic" });
            const result = await child.rotate({ ownerUserId: tokenOwner, id: original.row.id, revokePrevious: true });
            if (fail) throw fault;
            return result;
          }),
        recover: () =>
          transaction(async ({ child, projects }) => {
            await projects.create({ ownerUserId: tokenOwner, name: "must roll back" });
            try {
              await child.rotate({ ownerUserId: tokenOwner, id: randomUUID(), revokePrevious: true });
            } catch {}
          }),
      })),
    );
    await assert.rejects(parent.rotate(true), (error) => error === fault);
    assert.equal((await child.list(tokenOwner)).length, 1);
    assert.equal((await child.list(tokenOwner))[0]?.status, "active");
    assert.deepEqual(await projectsRepo.list({ ownerUserId: tokenOwner, limit: 10 }), []);
    await assert.rejects(parent.recover(), { code: "TRANSACTION_ROLLBACK_ONLY" });
    assert.deepEqual(await projectsRepo.list({ ownerUserId: tokenOwner, limit: 10 }), []);
    await scopedUow.transaction(async (tx) => {
      await parent.tx(tx).rotate(false);
    });
    assert.equal((await child.list(tokenOwner)).length, 2);
    assert.equal((await projectsRepo.list({ ownerUserId: tokenOwner, limit: 10 })).length, 1);
    assert.equal((await child.list(tokenOwner)).filter((token) => token.status === "active").length, 1);
  });

  await t.test("event ports share repeatable-read snapshots across concurrent commits", async () => {
    const conversation = await conversationRepository.create({
      ownerUserId: owner,
      mode: "chat",
      projectId: null,
      title: "Snapshot",
      metadata: {},
    });
    const reader = createConversationReader(db);
    const interleavedReader = createScope(db).get(
      defineService({ reader }, ({ reader }) => ({
        async readOwnedHead(input) {
          const head = await reader.readOwnedHead(input);
          // Commit on a different connection after the snapshot's first read.
          await scopedUow.transaction(async (writer) => {
            await createUiEventWriter(db)
              .tx(writer)
              .append(conversation.id, {
                sequence: "1",
                runId: null,
                type: "context.changed",
                payload: { epoch: 1, action: "clear" },
              });
            await writer
              .update(conversations)
              .set({ lastEventSequence: 1n })
              .where(eq(conversations.id, conversation.id));
          });
          return head;
        },
      })),
    );
    const events = createEventService(db, interleavedReader);
    assert.deepEqual(await events.cursorState({ conversationId: conversation.id, ownerUserId: owner }), {
      eventFloorSequence: 0n,
      lastEventSequence: 0n,
      oldestSequence: null,
    });
    const fresh = createEventService(db, reader);
    assert.deepEqual(await fresh.cursorState({ conversationId: conversation.id, ownerUserId: owner }), {
      eventFloorSequence: 0n,
      lastEventSequence: 1n,
      oldestSequence: 1n,
    });
    assert.equal(await fresh.cursorState({ conversationId: conversation.id, ownerUserId: randomUUID() }), null);
  });

  await t.test("journal, run projection and conversation head roll back together", async () => {
    const conversation = await newConversation();
    const prepared = await repository.prepare(conversation.id, randomUUID());
    assert.ok(prepared);
    const state = async () => ({
      head: await db.select().from(conversations).where(eq(conversations.id, conversation.id)),
      runs: await db.select().from(runs).where(eq(runs.conversationId, conversation.id)),
      events: await db
        .select()
        .from(uiEvents)
        .where(eq(uiEvents.conversationId, conversation.id))
        .orderBy(asc(uiEvents.sequence)),
    });
    const before = await state();
    const fault = new Error("Injected after journal append");
    await assert.rejects(
      scopedUow.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(conversations)
          .where(eq(conversations.id, conversation.id))
          .for("update");
        assert.ok(locked);
        const projection = await createScope(db)
          .get(runJournal)
          .tx(tx)
          .append(locked, {
            runId: prepared.run.id,
            type: "plan.changed",
            payload: { plan: [{ id: "atomic", text: "Save atomically", status: "pending" }] },
          });
        assert.equal(projection?.plan[0]?.id, "atomic");
        assert.equal(
          (await tx.select().from(uiEvents).where(eq(uiEvents.conversationId, conversation.id))).length,
          before.events.length + 1,
        );
        throw fault;
      }),
      (error) => error === fault,
    );
    assert.deepEqual(await state(), before);
  });

  await t.test("retention and deletion ports are atomic and preserve a contiguous suffix", async () => {
    const conversation = await conversationRepository.create({
      ownerUserId: owner,
      mode: "chat",
      projectId: null,
      title: "Retention",
      metadata: {},
    });
    const writer = createUiEventWriter(db);
    await scopedUow.transaction(async (tx) => {
      for (let sequence = 1; sequence <= 4; sequence++)
        await writer.tx(tx).append(conversation.id, {
          sequence: String(sequence),
          runId: null,
          type: "context.changed",
          payload: { epoch: 1, action: "clear" },
        });
      await tx.update(conversations).set({ lastEventSequence: 4n }).where(eq(conversations.id, conversation.id));
      await tx
        .update(uiEvents)
        .set({ occurredAt: new Date(0) })
        .where(and(eq(uiEvents.conversationId, conversation.id), sql`${uiEvents.sequence} in (1,3)`));
    });
    const heads = createConversationEventHeads(db);
    const fault = new Error("Injected after cursor update");
    const failingHeads = createScope(db).get(
      defineService({ heads }, ({ heads }) => ({
        ...heads,
        async advanceFloors(cutoffs) {
          await heads.advanceFloors(cutoffs);
          throw fault;
        },
      })),
    );
    const broken = new EventRetentionService(createScope(db).serviceTransaction({ writer, heads: failingHeads }));
    const events = () =>
      db.select().from(uiEvents).where(eq(uiEvents.conversationId, conversation.id)).orderBy(asc(uiEvents.sequence));
    const floor = async () =>
      (await db.select().from(conversations).where(eq(conversations.id, conversation.id)))[0]!.eventFloorSequence;
    await assert.rejects(broken.retain(), (error) => error === fault);
    assert.deepEqual(
      (await events()).map((event) => event.sequence),
      [1n, 2n, 3n, 4n],
    );
    assert.equal(await floor(), 0n);
    await Promise.all([
      eventRetention.retain(),
      eventRetention.retain(),
      scopedUow.transaction(async (tx) => {
        await tx.select().from(conversations).where(eq(conversations.id, conversation.id)).for("update");
        await writer.tx(tx).append(conversation.id, {
          sequence: "5",
          runId: null,
          type: "context.changed",
          payload: { epoch: 1, action: "clear" },
        });
        await tx.update(conversations).set({ lastEventSequence: 5n }).where(eq(conversations.id, conversation.id));
      }),
    ]);
    assert.deepEqual(
      (await events()).map((event) => event.sequence),
      [4n, 5n],
    );
    assert.equal(await floor(), 3n);
    await assert.rejects(
      scopedUow.transaction(async (tx) => {
        await writer.tx(tx).deleteConversation(conversation.id);
        throw fault;
      }),
      (error) => error === fault,
    );
    assert.deepEqual(
      (await events()).map((event) => event.sequence),
      [4n, 5n],
    );
    await assert.rejects(conversationRepository.maintain(conversation.id, randomUUID(), "delete"), {
      code: "NOT_FOUND",
    });
    await conversationRepository.maintain(conversation.id, owner, "delete");
    assert.deepEqual(await events(), []);
  });

  await t.test("Runner rotation and registration retain rollback and lock guarantees", async () => {
    const tokenOwner = randomUUID();
    const tokens = createRunnerTokenRepository(db);
    const directory = createRunnerRepository(db);
    const uow = createUnitOfWork(db);
    const key = "ab".repeat(32);
    const service = new RunnerTokenService(tokens, createScope(db).serviceTransaction({ repository: tokens }), key);
    const original = await service.create({ ownerUserId: tokenOwner, capabilities: ["fs.read"] });
    const fault = new Error("Injected after Runner write");
    const brokenTokens = createScope(db).get(
      defineService({ tokens }, ({ tokens }) => ({
        ...tokens,
        async markRotated(...args: Parameters<typeof tokens.markRotated>) {
          await tokens.markRotated(...args);
          throw fault;
        },
      })),
    );
    const brokenRotation = new RunnerTokenService(
      brokenTokens,
      createScope(db).serviceTransaction({ repository: brokenTokens }),
      key,
    );
    await assert.rejects(
      brokenRotation.rotate({ ownerUserId: tokenOwner, id: original.row.id, revokePrevious: true }),
      (error) => error === fault,
    );
    let listed = await service.list(tokenOwner);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.token, original.secret);
    assert.equal(listed[0]?.status, "active");
    const identity = {
      runnerId: randomUUID(),
      bootId: randomUUID(),
      workspaces: [{ workspaceId: "workspace" }],
      capabilities: ["fs.read"],
    };
    const failingTokens = createScope(db).get(
      defineService({ tokens }, ({ tokens }) => ({
        ...tokens,
        async markUsed(...args: Parameters<typeof tokens.markUsed>) {
          await tokens.markUsed(...args);
          throw fault;
        },
      })),
    );
    const brokenRegistration = new RunnerRegistrationService(
      failingTokens,
      createScope(db).serviceTransaction({ runners: directory, tokens: failingTokens }),
    );
    await assert.rejects(brokenRegistration.register(original.secret, identity), (error) => error === fault);
    assert.deepEqual(await directory.list(tokenOwner), []);
    assert.equal((await tokens.find(original.row.id))?.lastUsedAt, null);
    const registration = new RunnerRegistrationService(
      tokens,
      createScope(db).serviceTransaction({ runners: directory, tokens }),
    );
    const registered = await registration.register(original.secret, identity);
    assert.ok(registered);
    assert.ok((await tokens.find(original.row.id))?.lastUsedAt);
    const rotations = await Promise.allSettled(
      [1, 2].map(() => service.rotate({ ownerUserId: tokenOwner, id: original.row.id, revokePrevious: true })),
    );
    assert.equal(rotations.filter((result) => result.status === "fulfilled").length, 1);
    listed = await service.list(tokenOwner);
    assert.equal(listed.length, 2);
    assert.equal(listed.filter((row) => row.status === "active").length, 1);
    assert.equal(await registration.register(original.secret, identity), null);
    await assert.rejects(service.revoke({ ownerUserId: randomUUID(), id: listed[0]!.id }), { code: "NOT_FOUND" });
  });

  await t.test("project bindings read Runner state inside the same transaction and serialize revisions", async () => {
    const projectOwner = randomUUID();
    const [project] = await db.insert(projects).values({ ownerUserId: projectOwner, name: "Ports" }).returning();
    assert.ok(project);
    const runnerId = randomUUID();
    const bindingRepo = createProjectBindingRepository(db);
    const runnerReader = createRunnerReader(db);
    const uow = createUnitOfWork(db);
    const input = {
      runnerId,
      workspaceId: "workspace",
      canonicalCwd: "project",
      customPrompt: "",
      expectedRevision: 0,
    };
    const bindingTransaction = createScope(db).serviceTransaction({ repository: bindingRepo, runners: runnerReader });
    const service = createScope(db).get(
      defineService(
        { repository: bindingRepo, runners: runnerReader },
        ({ repository, runners, transaction }) => new ProjectBindingService(repository, transaction),
      ),
    );
    await scopedUow.transaction(async (tx) => {
      await tx
        .insert(runners)
        .values({ id: runnerId, ownerUserId: projectOwner, runnerId: "device", workspaceId: "workspace" });
      assert.equal((await service.tx(tx).bind(project.id, projectOwner, input)).revision, 1);
    });
    const fault = new Error("Injected after binding replacement");
    const failingBindings = createScope(db).get(
      defineService({ repository: bindingRepo }, ({ repository }) => ({
        ...repository,
        async touchProject(...args: Parameters<typeof repository.touchProject>) {
          await repository.touchProject(...args);
          throw fault;
        },
      })),
    );
    const broken = new ProjectBindingService(
      failingBindings,
      createScope(db).serviceTransaction({ repository: failingBindings, runners: runnerReader }),
    );
    await assert.rejects(
      broken.bind(project.id, projectOwner, { ...input, expectedRevision: 1 }),
      (error) => error === fault,
    );
    const bindings = await db.select().from(projectBindings).where(eq(projectBindings.projectId, project.id));
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0]?.isCurrent, true);
    const normal = new ProjectBindingService(bindingRepo, bindingTransaction);
    const results = await Promise.allSettled(
      [1, 2].map(() => normal.bind(project.id, projectOwner, { ...input, expectedRevision: 1 })),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await normal.get(project.id, projectOwner))?.revision, 2);
    await assert.rejects(
      normal.bind(project.id, projectOwner, { ...input, workspaceId: "changed", expectedRevision: 2 }),
      { code: "CONFLICT" },
    );
    await assert.rejects(normal.get(project.id, randomUUID()), { code: "NOT_FOUND" });
  });

  await t.test("attachment reads through conversations retain owner, message and block scope", async () => {
    const conversation = await newConversation();
    const messageId = randomUUID();
    await db.insert(messages).values({
      id: messageId,
      conversationId: conversation.id,
      sequence: 1n,
      role: "user",
      blocks: [
        {
          id: "image",
          type: "image",
          attachment: { name: "image.png", mimeType: "image/png", ref: { kind: "object", key: "owner/image.png" } },
        },
      ],
    });
    const service = new AttachmentService(createConversationReader(db), {
      ...disabledUploadStorage(),
      async readImage(ref) {
        assert.equal(ref.key, "owner/image.png");
        return { data: "image", mimeType: "image/png" };
      },
    });
    const input = { ownerUserId: owner, conversationId: conversation.id, messageId, blockId: "image" };
    assert.equal((await service.readImage(input)).data, "image");
    for (const invalid of [
      { ...input, ownerUserId: randomUUID() },
      { ...input, conversationId: randomUUID() },
      { ...input, messageId: randomUUID() },
      { ...input, blockId: "missing" },
    ])
      await assert.rejects(service.readImage(invalid), { code: "NOT_FOUND" });
  });

  await t.test("cursor precision, retention and unified HTTP errors", async (child) => {
    const conversation = await newConversation();
    await db
      .update(conversations)
      .set({ lastEventSequence: 9007199254740993n, eventFloorSequence: 9007199254740993n })
      .where(eq(conversations.id, conversation.id));
    const app = await buildApp(loadConfig({ DATABASE_URL: target.toString(), LOG_LEVEL: "silent", AUTH_MODE: "dev" }), {
      exportMode: true,
    });
    await app.ready();
    child.after(() => app.close());
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/conversations/" })).statusCode, 404);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/conversations/",
          payload: { mode: "chat", initialInput: { blocks: [] } },
        })
      ).statusCode,
      400,
    );
    assert.equal((await app.inject({ method: "GET", url: "/api/conversations/" })).statusCode, 401);
    const auth = { authorization: "Bearer dev:" + owner + ":cursor-owner" };
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/conversations/" + conversation.id + "/events?cursor=9007199254740992",
          headers: auth,
        })
      ).statusCode,
      410,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/conversations/" + conversation.id + "/events?cursor=9223372036854775808",
          headers: auth,
        })
      ).statusCode,
      400,
    );
    await db
      .update(uiEvents)
      .set({ occurredAt: new Date(0) })
      .where(eq(uiEvents.conversationId, conversation.id));
    await repository.recover();
    await eventRetention.retain();
    const [row] = await db.select().from(conversations).where(eq(conversations.id, conversation.id));
    assert.equal(row?.lastEventSequence.toString(), "9007199254740993");
    assert.equal(row?.eventFloorSequence.toString(), "9007199254740993");
  });
});
