import { createScope, defineRepository, type RepositoryDatabase, type TransactionOptions } from "../../shared/scope.js";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import {
  applyEvent,
  configurationSchema,
  isActiveRun,
  messageSchema,
  productEventSchema,
  validInteractionResponse,
  type Interaction,
  type InteractionResponse,
  type Message,
  type ProductEvent,
  type RuntimeEvent,
  type Snapshot,
  type SubmitInput,
} from "@nova/agent-ui-contracts";
import {
  conversations,
  messages,
  pendingInputs,
  runs,
  specs,
  specRevisions,
  specTaskAttempts,
  sessionCommits,
  type Database,
  type RunState,
} from "../../../database/index.js";
import { eventWriter, type UiEventWriter } from "../events/index.js";
import { enqueue } from "../../jobs/postgres-job-store.js";
import { DomainError } from "../../shared/domain-error.js";
import { runtimeAdapters, runView, type Checkpoint } from "./runtime-adapter.js";
import { bindingSchema } from "../projects/index.js";
import { advanceStream, streamStateOf, type StreamState } from "./stream-state.js";
import { runProjectionReader, type RunProjectionReader } from "./run-projection.repository.js";
import { readCheckpoint } from "./session-checkpoint.repository.js";
import { checkpointAfter } from "./session-checkpoint.js";
import { taskPlanSchema } from "../specs/spec.schema.js";
import { specDraftCandidateSchema } from "@nova/tools/harness";
import { acceptanceCriteriaIn, validateTaskPlan } from "../specs/spec.validation.js";
import {
  conversationView,
  effectiveCapabilities,
  emptyProjection,
  fingerprint,
  nativeBlocks,
  nativeThinkingBlocks,
  publicInteraction,
  queuedInput,
  type ConversationRow,
} from "./run-dto.js";

import type { Transaction } from "../../shared/unit-of-work.js";
export type { Transaction } from "../../shared/unit-of-work.js";
export type { ConversationRow } from "./run-dto.js";
export type RunRow = typeof runs.$inferSelect;
export type RunClaim = { id: string; conversationId: string; workerId: string; fence: number };
type RunOutput = Pick<RunRow, "id" | "workerId" | "fence" | "leaseUntil" | "streamState"> & { hasCheckpoint: boolean };
const sessionColumns = {
  ...getTableColumns(runs),
  checkpoint: sql<Checkpoint | null>`${runs.checkpointMetadata}`,
  projection: sql<null>`null`,
};
/** Caller holds the conversation and run locks for the entire batch. */
function createEventBatch(
  conversation: ConversationRow,
  writer: UiEventWriter,
  run?: Pick<RunRow, "id" | "projection">,
) {
  const events: ProductEvent[] = [];
  let projection: Snapshot | undefined = run
    ? {
        ...(run.projection ?? emptyProjection(conversation)),
        cursor: conversation.lastEventSequence.toString(),
        conversation: conversationView(conversation),
      }
    : undefined;
  return {
    get projection() {
      return projection;
    },
    append(event: RuntimeEvent) {
      const sequence = conversation.lastEventSequence + BigInt(events.length) + 1n;
      const accepted = productEventSchema.parse({ ...event, sequence: sequence.toString() });
      if (projection) projection = applyEvent(projection, accepted);
      events.push(accepted);
    },
    async flush(tx: Transaction, metadata?: ConversationRow["metadata"]) {
      if (!events.length && !metadata) return;
      if (events.length && run && projection) {
        const serialized = JSON.stringify(projection);
        if (Buffer.byteLength(serialized) > 4 * 1024 * 1024)
          throw new DomainError("CONFLICT", "Run output exceeded its storage limit");
        await tx
          .update(runs)
          .set({
            projection: sql`${serialized}::jsonb`,
            streamState: streamStateOf(projection, Buffer.byteLength(serialized)),
          })
          .where(eq(runs.id, run.id));
      }
      await writer.appendBatch(conversation.id, events);
      const sequence = conversation.lastEventSequence + BigInt(events.length);
      await tx
        .update(conversations)
        .set({
          lastEventSequence: sequence,
          lastMessageSequence: conversation.lastMessageSequence,
          updatedAt: new Date(),
          ...(metadata ? { metadata } : {}),
        })
        .where(eq(conversations.id, conversation.id));
      conversation.lastEventSequence = sequence;
    },
  };
}
/** Caller holds the conversation lock. Journal, projection and head move together. */
async function appendEvent(
  tx: Transaction,
  conversation: ConversationRow,
  event: RuntimeEvent,
  writer: UiEventWriter,
  projectionReader: RunProjectionReader,
) {
  const projectionRunId = event.runId ?? conversation.activeRunId ?? conversation.metadata.latestRunId;
  const [run] = projectionRunId
    ? await tx
        .select({ id: runs.id, projection: runs.projection })
        .from(runs)
        .where(eq(runs.id, projectionRunId))
        .for("update")
    : [];
  if (run?.projection) run.projection = await projectionReader.read(conversation, run.projection);
  const batch = createEventBatch(conversation, writer, run);
  batch.append(event);
  await batch.flush(tx);
  return batch.projection;
}
export const runJournal = defineRepository(
  { events: eventWriter, projection: runProjectionReader },
  ({ db, requireTransaction, events, projection }) => ({
    append(conversation: ConversationRow, event: RuntimeEvent) {
      return appendEvent(requireTransaction(), conversation, event, events, projection);
    },
    async wake(id: string, key: string = randomUUID()) {
      requireTransaction();
      await enqueue({ db, job: { kind: "run.wake", aggregateId: id, dedupeKey: key, payload: { conversationId: id } } });
    },
  }),
);
export type RunJournal = import("../../shared/scope.js").Scoped<{
  append(conversation: ConversationRow, event: RuntimeEvent): Promise<Snapshot | undefined>;
  wake(id: string, key?: string): Promise<void>;
}>;
export class RunRepository {
  constructor(
    private readonly db: RepositoryDatabase,
    private readonly transactionContext: (options?: TransactionOptions) => Transaction,
    private readonly journal: RunJournal,
    private readonly events: UiEventWriter,
    private readonly projection: RunProjectionReader,
  ) {}
  async prepare(conversationId: string, workerId: string) {
    const tx = this.transactionContext();

    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for("update");
    if (!conversation) return null;
    const [activeRun] = conversation.activeRunId
      ? await tx.select().from(runs).where(eq(runs.id, conversation.activeRunId)).for("update")
      : [];
    const run = activeRun
      ? await this.resumeClaim(tx, conversation, activeRun, workerId)
      : await this.startQueuedRun(tx, conversation, workerId);
    if (!run?.checkpoint) return null;
    await this.journal.append(conversation, {
      runId: run.id,
      type: "run.changed",
      payload: {
        run: runView(run),
        configuration: run.checkpoint.configuration,
        capabilities: effectiveCapabilities(conversation),
      },
    });
    const reserved = run.checkpoint.reservedInputs[0];
    const [input] = reserved
      ? await tx.select().from(pendingInputs).where(eq(pendingInputs.id, reserved.id)).limit(1)
      : [];
    const continueGoal =
      run.checkpoint.outcome?.state === "succeeded" &&
      conversation.metadata.goal?.status === "active" &&
      conversation.metadata.goal.iterations < conversation.metadata.goal.maxIterations;
    const execution = run.checkpoint.specExecution;
    const [specRevision] = execution
      ? await tx.select().from(specRevisions).where(and(
          eq(specRevisions.specId, execution.specId), eq(specRevisions.revision, execution.revision),
        )).limit(1)
      : [];
    return {
      run,
      conversation,
      specRevision: specRevision ?? null,
      configuration: run.checkpoint.configuration,
      binding: conversation.metadata.binding ? bindingSchema.parse(conversation.metadata.binding) : null,
      command:
        run.checkpoint.continuation || (run.checkpoint.outcome && !continueGoal)
          ? { kind: "recover" as const }
          : {
              kind: "start" as const,
              messageId: reserved?.messageId ?? randomUUID(),
              input: input
                ? { blocks: input.payload.blocks, mode: input.mode }
                : {
                    blocks: [{ id: "text", type: "text" as const, text: "继续推进当前目标，复核完成标准。" }],
                    mode: "next_run" as const,
                  },
            },
    };
  }
  /**
   * Take over the conversation's active run after expiring stale pending interactions.
   * Null means "not claimable right now": live lease, waiting on an interaction or terminal state.
   * Caller already holds the conversation and run row locks.
   */
  private async resumeClaim(
    tx: Transaction,
    conversation: ConversationRow,
    activeRun: RunRow,
    workerId: string,
  ): Promise<RunRow | null> {
    let run = activeRun;
    if (run.leaseUntil && run.leaseUntil.getTime() > Date.now()) return null;
    run.checkpoint = await readCheckpoint(tx, run);
    if (run.projection) run.projection = await this.projection.read(conversation, run.projection);
    if (!run.checkpoint) throw new DomainError("CONFLICT", "Run has no recoverable checkpoint");
    let checkpoint = structuredClone(run.checkpoint);
    let changed = false;
    checkpoint.interactions = checkpoint.interactions.map((interaction) => {
      if (
        interaction.state === "pending" &&
        interaction.expiresAt &&
        Date.parse(interaction.expiresAt) <= Date.now()
      ) {
        changed = true;
        return { ...interaction, state: "expired" as const, revision: interaction.revision + 1 };
      }
      return interaction;
    });
    if (changed) {
      await tx
        .update(runs)
        .set({ ...checkpointStorage(checkpoint), revision: run.revision + 1, checkpointRevision: run.revision + 1 })
        .where(eq(runs.id, run.id));
      for (const interaction of checkpoint.interactions.filter((item) => item.state === "expired"))
        await this.journal.append(conversation, {
          runId: run.id,
          type: "interaction.changed",
          payload: { interaction: publicInteraction(interaction) },
        });
      run = { ...run, checkpoint, revision: run.revision + 1, checkpointRevision: run.revision + 1 };
    }
    if (run.state === "waiting" && checkpoint.interactions.some((interaction) => interaction.state === "pending"))
      return null;
    if (!isActiveRun(run.state)) return null;
    const [claimed] = await tx
      .update(runs)
      .set({
        workerId,
        fence: run.fence + 1,
        leaseUntil: new Date(Date.now() + 30000),
        state: run.state === "cancelling" ? "cancelling" : "running",
        updatedAt: new Date(),
      })
      .where(eq(runs.id, run.id))
      .returning();
    return { ...claimed!, checkpoint: await readCheckpoint(tx, claimed!) };
  }
  /**
   * Open the next run for a queued input or a ready goal, inheriting the previous checkpoint
   * when the backend and context epoch still match. Null means "nothing to start".
   * Caller already holds the conversation row lock.
   */
  private async startQueuedRun(
    tx: Transaction,
    conversation: ConversationRow,
    workerId: string,
  ): Promise<RunRow | null> {
    const [unknown] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.conversationId, conversation.id), eq(runs.state, "cancelled_unconfirmed")))
      .limit(1);
    if (unknown) return null;
    const [input] = await tx
      .select()
      .from(pendingInputs)
      .where(and(eq(pendingInputs.conversationId, conversation.id), eq(pendingInputs.status, "queued")))
      .orderBy(asc(pendingInputs.sequence))
      .limit(1);
    const goal = conversation.metadata.goal;
    if (!input && !(goal?.status === "ready" && goal.iterations < goal.maxIterations)) return null;
    const configuration = configurationSchema.parse(
      input?.payload.configuration ?? conversation.metadata.configuration ?? {},
    );
    if (!runtimeAdapters.has(configuration.backendId))
      throw new DomainError("VALIDATION_ERROR", "Backend is not registered");
    if (
      configuration.backendId !== conversation.metadata.configuration?.backendId &&
      conversation.metadata.latestCheckpointRunId
    ) {
      conversation.contextEpoch++;
      conversation.metadata.latestCheckpointRunId = null;
      await tx
        .update(conversations)
        .set({ contextEpoch: conversation.contextEpoch, metadata: conversation.metadata })
        .where(eq(conversations.id, conversation.id));
      await this.journal.append(conversation, {
        runId: null,
        type: "context.changed",
        payload: { epoch: conversation.contextEpoch, action: "backend_change" },
      });
    }
    const [previous] = conversation.metadata.latestCheckpointRunId
      ? await tx.select().from(runs).where(eq(runs.id, conversation.metadata.latestCheckpointRunId)).limit(1)
      : [];
    if (previous) previous.checkpoint = await readCheckpoint(tx, previous);
    const inherited =
      previous?.checkpoint?.backendId === configuration.backendId &&
      previous.checkpoint.epoch === conversation.contextEpoch
        ? previous.checkpoint
        : null;
    const messageId = randomUUID();
    const environment = environmentKey(conversation, configuration);
    if (await environmentUnsettled(tx, conversation, configuration)) return null;
    let specExecution: Checkpoint["specExecution"] = input?.payload.spec;
    if (!specExecution && conversation.metadata.specId) {
      const [spec] = await tx.select().from(specs).where(and(
        eq(specs.id, conversation.metadata.specId), eq(specs.conversationId, conversation.id),
      )).for("update");
      if (!spec) return null;
      specExecution = { kind: "discussion", specId: spec.id, revision: spec.currentRevision };
    }
    const checkpoint: Checkpoint = {
      backendId: configuration.backendId,
      epoch: conversation.contextEpoch,
      configuration,
      nativeState: inherited?.nativeState ?? { messages: [], runs: [] },
      executions: [],
      interactions: [],
      approvals:
        conversation.metadata.toolApprovals?.environment === environment
          ? conversation.metadata.toolApprovals.names
          : [],
      reservedInputs: input ? [{ id: input.id, messageId }] : [],
      ...(specExecution ? { specExecution } : {}),
    };
    const [created] = await tx
      .insert(runs)
      .values({
        conversationId: conversation.id,
        state: "running",
        workerId,
        leaseUntil: new Date(Date.now() + 30000),
        deadlineAt: new Date(Date.now() + 30 * 60000),
        budget: { maxToolCalls: 64 },
        ...checkpointStorage(checkpoint),
        projection: emptyProjection(conversation),
      })
      .returning();
    const run = created!;
    if (input) await tx.update(pendingInputs).set({ runId: run.id, messageId }).where(eq(pendingInputs.id, input.id));
    conversation.activeRunId = run.id;
    conversation.metadata = {
      ...conversation.metadata,
      configuration,
      latestRunId: run.id,
      ...(goal && goal.status !== "paused" && goal.status !== "completed"
        ? { goal: { ...goal, status: "active", revision: goal.revision + 1 } }
        : {}),
    };
    await tx
      .update(conversations)
      .set({ activeRunId: run.id, metadata: conversation.metadata })
      .where(eq(conversations.id, conversation.id));
    if (conversation.metadata.goal)
      await this.journal.append(conversation, {
        runId: run.id,
        type: "goal.changed",
        payload: { goal: conversation.metadata.goal },
      });
    return run;
  }
  private async ownedClaim(tx: Transaction, claim: RunClaim): Promise<{ conversation: ConversationRow; run: RunRow }>;
  private async ownedClaim(
    tx: Transaction,
    claim: RunClaim,
    outputOnly: true,
  ): Promise<{ conversation: ConversationRow; run: RunOutput }>;
  private async ownedClaim(
    tx: Transaction,
    claim: RunClaim,
    mode: "session",
  ): Promise<{ conversation: ConversationRow; run: RunRow }>;
  private async ownedClaim(tx: Transaction, claim: RunClaim, outputOnly: boolean | "session" = false) {
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, claim.conversationId))
      .for("update");
    const [run] =
      outputOnly === true
        ? await tx
            .select({
              id: runs.id,
              workerId: runs.workerId,
              fence: runs.fence,
              leaseUntil: runs.leaseUntil,
              streamState: runs.streamState,
              hasCheckpoint: sql<boolean>`${runs.checkpoint} is not null`,
            })
            .from(runs)
            .where(eq(runs.id, claim.id))
            .for("update")
        : outputOnly === "session"
          ? await tx.select(sessionColumns).from(runs).where(eq(runs.id, claim.id)).for("update")
          : await tx.select().from(runs).where(eq(runs.id, claim.id)).for("update");
    if (
      !conversation ||
      conversation.activeRunId !== claim.id ||
      !run ||
      run.workerId !== claim.workerId ||
      run.fence !== claim.fence ||
      !run.leaseUntil ||
      run.leaseUntil.getTime() <= Date.now()
    )
      throw new DomainError("CONFLICT", "Run lease or fence changed");
    if (!outputOnly && "checkpoint" in run) run.checkpoint = await readCheckpoint(tx, run);
    if (!outputOnly && "projection" in run && run.projection)
      run.projection = await this.projection.read(conversation, run.projection);
    return { conversation, run };
  }
  async state(claim: RunClaim) {
    const [run] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, claim.id), eq(runs.workerId, claim.workerId), eq(runs.fence, claim.fence)));
    return run ?? null;
  }
  async watch(claim: RunClaim) {
    const [run] = await this.db
      .select({ state: runs.state, goalStatus: sql<string | null>`${conversations.metadata}->'goal'->>'status'` })
      .from(runs)
      .innerJoin(conversations, eq(conversations.id, runs.conversationId))
      .where(and(eq(runs.id, claim.id), eq(runs.workerId, claim.workerId), eq(runs.fence, claim.fence)));
    return run ?? null;
  }
  async heartbeat(claim: RunClaim) {
    const [row] = await this.db
      .update(runs)
      .set({ leaseUntil: new Date(Date.now() + 30000) })
      .where(
        and(
          eq(runs.id, claim.id),
          eq(runs.workerId, claim.workerId),
          eq(runs.fence, claim.fence),
          sql`${runs.leaseUntil}>now()`,
          sql`${runs.state} in ('running','cancelling','waiting')`,
        ),
      )
      .returning({ id: runs.id });
    return Boolean(row);
  }
  async sessionRevision(claim: RunClaim) {
    const [run] = await this.db
      .select({ revision: runs.revision })
      .from(runs)
      .where(and(eq(runs.id, claim.id), eq(runs.workerId, claim.workerId), eq(runs.fence, claim.fence)));
    if (!run) throw new DomainError("CONFLICT", "Run lease or fence changed");
    return run.revision;
  }
  private async appendJournal(
    tx: Transaction,
    conversation: ConversationRow,
    run: Pick<RunRow, "id" | "streamState">,
    events: RuntimeEvent[],
    metadata = conversation.metadata,
    changes: Partial<Pick<RunRow, "revision" | "effectState">> = {},
  ) {
    let positions = run.streamState;
    if (!positions) {
      const [saved] = await tx.select({ projection: runs.projection }).from(runs).where(eq(runs.id, run.id));
      positions = streamStateOf(
        saved?.projection ? await this.projection.read(conversation, saved.projection) : emptyProjection(conversation),
      );
    }
    const accepted = events.map((event, index) =>
      productEventSchema.parse({
        ...event,
        sequence: (conversation.lastEventSequence + BigInt(index) + 1n).toString(),
      }),
    );
    for (const event of accepted) advanceStream(positions, event);
    await this.persistJournal(tx, conversation, run.id, positions, accepted, metadata, changes);
  }
  private async persistJournal(
    tx: Transaction,
    conversation: ConversationRow,
    runId: string,
    positions: StreamState,
    accepted: ProductEvent[],
    metadata: ConversationRow["metadata"],
    changes: Partial<Pick<RunRow, "revision" | "effectState">> = {},
  ) {
    await this.events.appendBatch(conversation.id, accepted);
    conversation.lastEventSequence += BigInt(accepted.length);
    positions.pendingBytes += accepted.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
    let projectionUpdate = {};
    // Growing snapshots set their own next threshold: text growth produces geometric,
    // rather than timer-driven, full writes. Bounded output tails checkpoint by traffic.
    if (
      positions.pendingBytes >= Math.max(256 * 1024, positions.bytes) ||
      positions.bytes + positions.pendingOutputBytes > 4 * 1024 * 1024
    ) {
      const [saved] = await tx.select({ projection: runs.projection }).from(runs).where(eq(runs.id, runId));
      const projection = await this.projection.read(
        conversation,
        saved?.projection ?? emptyProjection({ ...conversation, lastEventSequence: 0n }),
      );
      const serialized = JSON.stringify(projection);
      const bytes = Buffer.byteLength(serialized);
      if (bytes > 4 * 1024 * 1024) throw new DomainError("CONFLICT", "Run output exceeded its storage limit");
      positions = streamStateOf(projection, bytes);
      projectionUpdate = { projection: sql`${serialized}::jsonb` };
    }
    await tx
      .update(runs)
      .set({ ...changes, ...projectionUpdate, streamState: positions, updatedAt: new Date() })
      .where(eq(runs.id, runId));
    await tx
      .update(conversations)
      .set({
        lastEventSequence: conversation.lastEventSequence,
        lastMessageSequence: conversation.lastMessageSequence,
        metadata,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversation.id));
  }
  async load(claim: RunClaim) {
    this.transactionContext({ isolationLevel: "repeatable read" });
    const run = await this.state(claim);
    if (!run?.checkpoint) throw new DomainError("CONFLICT", "Checkpoint unavailable");
    run.checkpoint = (await readCheckpoint(this.db, run))!;
    if (run.projection) {
      const [conversation] = await this.db
        .select({ id: conversations.id, lastEventSequence: conversations.lastEventSequence })
        .from(conversations)
        .where(eq(conversations.id, claim.conversationId));
      if (conversation) run.projection = await this.projection.read(conversation, run.projection);
    }
    return { checkpoint: run.checkpoint, revision: run.revision, projection: run.projection };
  }
  async pinModel(claim: RunClaim, modelId: string) {
    const tx = this.transactionContext();

    const { conversation, run } = await this.ownedClaim(tx, claim);
    if (!run.checkpoint) throw new DomainError("CONFLICT", "Checkpoint unavailable");
    if (run.checkpoint.configuration.modelId !== null) return;
    const configuration = { ...run.checkpoint.configuration, modelId };
    await tx
      .update(runs)
      .set({
        ...checkpointStorage({ ...run.checkpoint, configuration }),
        revision: run.revision + 1,
        checkpointRevision: run.revision + 1,
      })
      .where(eq(runs.id, run.id));
    conversation.metadata = { ...conversation.metadata, configuration };
    await tx
      .update(conversations)
      .set({ metadata: conversation.metadata })
      .where(eq(conversations.id, conversation.id));
    await this.journal.append(conversation, {
      runId: run.id,
      type: "run.changed",
      payload: { run: runView(run), configuration, capabilities: effectiveCapabilities(conversation) },
    });
  }
  async releaseForRecovery(claim: RunClaim) {
    const tx = this.transactionContext();

    const { conversation, run } = await this.ownedClaim(tx, claim);
    await tx
      .update(runs)
      .set({ state: "queued", workerId: null, leaseUntil: null, fence: run.fence + 1 })
      .where(eq(runs.id, run.id));
    await this.journal.append(conversation, {
      runId: run.id,
      type: "run.changed",
      payload: { run: { id: run.id, state: "queued", reason: "CHECKPOINT_CONFIRMATION_LOST" } },
    });
    await this.journal.wake(conversation.id, "recover:" + run.id + ":" + run.revision);
  }
  async commit(
    claim: RunClaim,
    expectedRevision: number,
    checkpoint: Checkpoint,
    events: RuntimeEvent[] = [],
    consumedInputIds: string[] = [],
  ) {
    const tx = this.transactionContext();

    const { conversation, run } = await this.ownedClaim(tx, claim);
    if (run.revision !== expectedRevision)
      throw new DomainError("CONFLICT", "Checkpoint revision changed", { reason: "REVISION_CONFLICT" });
    if (checkpoint.backendId !== run.checkpoint?.backendId || checkpoint.epoch !== conversation.contextEpoch)
      throw new DomainError("CONFLICT", "Checkpoint backend or epoch changed");
    checkpoint = {
      ...checkpoint,
      reservedInputs: checkpoint.reservedInputs.filter((input) => !consumedInputIds.includes(input.id)),
    };
    if (
      Buffer.byteLength(JSON.stringify(checkpoint)) > 8 * 1024 * 1024 ||
      checkpoint.executions.length > 1000 ||
      checkpoint.interactions.length > 100
    )
      throw new DomainError("CONFLICT", "Checkpoint storage limit exceeded");
    await tx
      .update(runs)
      .set({
        ...checkpointStorage(checkpoint),
        revision: run.revision + 1,
        checkpointRevision: run.revision + 1,
        effectState: executionEffectState(checkpoint.executions),
        updatedAt: new Date(),
      })
      .where(eq(runs.id, run.id));
    const output = createEventBatch(conversation, this.events, run);
    for (let event of events) {
      if (
        (event.type === "message.started" || event.type === "message.committed") &&
        event.payload.message.sequence === "0"
      ) {
        const incoming = event.payload.message;
        const draft = run.projection?.messages.find((message) => message.id === incoming.id);
        event = {
          ...event,
          payload: {
            message: {
              ...event.payload.message,
              sequence: draft?.sequence ?? (++conversation.lastMessageSequence).toString(),
            },
          },
        };
      }
      if (event.type === "message.committed") {
        const message = event.payload.message;
        await insertMessage(tx, conversation.id, message);
      }
      output.append(event);
    }
    for (const id of consumedInputIds) {
      const [input] = await tx
        .update(pendingInputs)
        .set({ status: "consumed", consumedAt: new Date() })
        .where(and(eq(pendingInputs.id, id), eq(pendingInputs.runId, run.id), eq(pendingInputs.status, "queued")))
        .returning();
      if (
        !input?.messageId ||
        !events.some(
          (event) =>
            event.type === "message.committed" &&
            event.payload.message.id === input.messageId &&
            event.payload.message.role === "user",
        )
      )
        throw new DomainError("CONFLICT", "Input was not confirmed in checkpoint");
      output.append({
        runId: run.id,
        type: "input.consumed",
        payload: { input: queuedInput(input) },
      });
    }
    conversation.metadata = { ...conversation.metadata, latestCheckpointRunId: run.id };
    await output.flush(tx, conversation.metadata);
    return run.revision + 1;
  }
  async commitSession(
    claim: RunClaim,
    expectedRevision: number,
    next: import("@nnova/harness").SessionSnapshot,
    batch: import("@nnova/harness").SessionCommit,
    checkpointBytes?: number,
  ) {
    // Native facts and their public projection share the same fenced transaction.
    const tx = this.transactionContext();

    const { conversation, run } = await this.ownedClaim(tx, claim, "session");
    if (run.revision !== expectedRevision)
      throw new DomainError("CONFLICT", "Checkpoint revision changed", { reason: "REVISION_CONFLICT" });
    if (!run.checkpoint) throw new DomainError("CONFLICT", "Checkpoint unavailable");
    if (next.executions.length > Number(run.budget.maxToolCalls ?? 64))
      throw new DomainError("CONFLICT", "Tool execution limit exceeded");
    if (run.state === "cancelling" && batch.execution?.dispatch === "dispatched" && !batch.execution.result)
      throw new DomainError("CONFLICT", "Run is cancelling", { reason: "NOT_DISPATCHED" });
    if (
      batch.execution?.dispatch === "dispatched" &&
      !batch.execution.result &&
      batch.execution.effects !== "read" &&
      (await environmentUnsettled(tx, conversation, run.checkpoint.configuration))
    )
      throw new DomainError("CONFLICT", "Execution environment requires inspection", { reason: "NOT_DISPATCHED" });
    const checkpoint = checkpointAfter(run.checkpoint, next, batch);
    const bytes = checkpointBytes ?? Buffer.byteLength(JSON.stringify(checkpoint));
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 8 * 1024 * 1024 || checkpoint.executions.length > 1000)
      throw new DomainError("CONFLICT", "Checkpoint storage limit exceeded");
    await tx.insert(sessionCommits).values({ runId: run.id, revision: run.revision + 1, batch });
    const emitted: RuntimeEvent[] = [];
    const positions = run.streamState;
    for (const native of batch.messages ?? []) {
      const id = native.id;
      if (!id) throw new Error("Native message requires stable identity");
      const draft = positions?.messages.find((message) => message.id === id);
      const sequence = draft?.sequence ?? (++conversation.lastMessageSequence).toString();
      const blocks = nativeBlocks(native.parts, next.executions, id);
      if (native.role === "user") {
        const reserved = run.checkpoint.reservedInputs.find((input) => input.messageId === id);
        if (reserved) {
          const [input] = await tx.select().from(pendingInputs).where(eq(pendingInputs.id, reserved.id));
          if (input) {
            blocks.splice(0, blocks.length, ...input.payload.blocks);
            await tx
              .update(pendingInputs)
              .set({ status: "consumed", consumedAt: new Date() })
              .where(eq(pendingInputs.id, input.id));
            emitted.push({
              runId: run.id,
              type: "input.consumed",
              payload: { input: { ...queuedInput(input), state: "consumed" } },
            });
          }
        }
      }
      blocks.unshift(...nativeThinkingBlocks(native.metadata));
      const message = messageSchema.parse({
        id,
        runId: run.id,
        sequence,
        role: native.role,
        state: "completed",
        blocks,
        createdAt: draft?.createdAt ?? new Date().toISOString(),
      });
      await insertMessage(tx, conversation.id, message);
      emitted.push({ runId: run.id, type: "message.committed", payload: { message } });
    }
    if (batch.execution) {
      const entry = batch.execution;
      const result = entry.result;

      emitted.push({
        runId: run.id,
        type: "tool.changed",
        payload: {
          operation: {
            id: entry.executionId,
            callId: entry.callId,
            state: result
              ? result.outcome === "unknown"
                ? "unknown"
                : result.error?.code === "TOOL_DENIED"
                  ? "denied"
                  : result.status
              : entry.dispatch === "dispatched"
                ? "running"
                : "queued",
          },
        },
      });
    }
    if (batch.run)
      emitted.push({
        runId: run.id,
        type: "usage.changed",
        payload: {
          usage: {
            ...(batch.run.usage.inputTokens !== null ? { inputTokens: batch.run.usage.inputTokens } : {}),
            ...(batch.run.usage.outputTokens !== null ? { outputTokens: batch.run.usage.outputTokens } : {}),
          },
        },
      });
    conversation.metadata = { ...conversation.metadata, latestCheckpointRunId: run.id };
    await this.appendJournal(tx, conversation, run, emitted, conversation.metadata, {
      revision: run.revision + 1,
      effectState: executionEffectState(next.executions),
    });
    return run.revision + 1;
  }
  async publish(claim: RunClaim, event: RuntimeEvent) {
    const tx = this.transactionContext();

    const { conversation, run } = await this.ownedClaim(tx, claim);
    if (event.type === "message.started") {
      const incoming = event.payload.message;
      if (run.projection?.messages.some((message) => message.id === incoming.id)) return;
      event = {
        ...event,
        payload: { message: { ...event.payload.message, sequence: (++conversation.lastMessageSequence).toString() } },
      };
    }
    await this.journal.append(conversation, event);
  }
  async publishNativeEvents(claim: RunClaim, batchId: string, events: readonly import("@nnova/harness").AgentEvent[]) {
    const tx = this.transactionContext();

    const { conversation, run } = await this.ownedClaim(tx, claim, true);
    if (!run.hasCheckpoint) throw new DomainError("CONFLICT", "Checkpoint unavailable");
    // A lost commit acknowledgement retries this exact batch, without replaying its offsets.
    if (conversation.metadata.lastEventBatchId === batchId) return;
    let positions = run.streamState;
    if (!positions) {
      const [saved] = await tx.select({ projection: runs.projection }).from(runs).where(eq(runs.id, run.id));
      positions = streamStateOf(
        saved?.projection ? await this.projection.read(conversation, saved.projection) : emptyProjection(conversation),
      );
    }
    const accepted: ProductEvent[] = [];
    const publish = (event: RuntimeEvent) => {
      if (event.type === "message.started") {
        const incoming = event.payload.message;
        if (positions.messages.some((message) => message.id === incoming.id)) return;
        event = {
          ...event,
          payload: {
            message: { ...event.payload.message, sequence: (++conversation.lastMessageSequence).toString() },
          },
        };
      }
      const parsed = productEventSchema.parse({
        ...event,
        sequence: (conversation.lastEventSequence + BigInt(accepted.length) + 1n).toString(),
      });
      advanceStream(positions, parsed);
      accepted.push(parsed);
    };
    for (const event of events) {
      if (event.runId !== claim.id) throw new DomainError("CONFLICT", "Event run changed");
      if (event.type === "message.started") {
        publish({
          runId: claim.id,
          type: "message.started",
          payload: {
            message: {
              id: event.messageId,
              runId: claim.id,
              sequence: "0",
              role: "assistant",
              state: "streaming",
              blocks: [],
              createdAt: new Date(event.timestamp ?? Date.now()).toISOString(),
            },
          },
        });
      } else if (event.type === "assistant.delta") {
        const message = positions.messages.find((item) => item.id === event.messageId);
        if (!message) throw new Error("Missing streaming message");
        const prior = message.blocks.find((block) => block.id === event.blockId);
        if (!prior)
          publish({
            runId: claim.id,
            type: "block.upsert",
            payload: {
              messageId: event.messageId,
              index: message.blocks.length,
              block: { id: event.blockId, type: event.contentType, text: "" },
            },
          });
        publish({
          runId: claim.id,
          type: "text.delta",
          payload: {
            messageId: event.messageId,
            blockId: event.blockId,
            offset: prior?.offset ?? 0,
            text: event.text,
          },
        });
      } else if (event.type === "assistant.reset") {
        for (const block of positions.messages.find((message) => message.id === event.messageId)?.blocks ?? [])
          if (block.type === "text" || block.type === "thinking")
            publish({
              runId: claim.id,
              type: "text.reset",
              payload: { messageId: event.messageId, blockId: block.id, text: "" },
            });
      } else if (event.type === "tool.output")
        publish({
          runId: claim.id,
          type: "tool.output",
          payload: {
            operationId: event.executionId,
            channel: event.channel,
            offset: event.offset,
            text: event.text,
          },
        });
    }
    await this.persistJournal(tx, conversation, run.id, positions, accepted, {
      ...conversation.metadata,
      lastEventBatchId: batchId,
    });
  }
  async reserveSteering(claim: RunClaim) {
    const tx = this.transactionContext();

    const { conversation } = await this.ownedClaim(tx, claim, true);
    const inputs = await tx
      .select()
      .from(pendingInputs)
      .where(
        and(
          eq(pendingInputs.conversationId, conversation.id),
          eq(pendingInputs.status, "queued"),
          eq(pendingInputs.mode, "steer"),
          sql`${pendingInputs.runId} is null`,
        ),
      )
      .orderBy(asc(pendingInputs.sequence))
      .limit(8);
    if (!inputs.length) return [];
    const { run } = await this.ownedClaim(tx, claim);
    if (!run.checkpoint) return [];
    const reserved = inputs.map((input) => ({ id: input.id, messageId: input.messageId ?? randomUUID() }));
    for (const input of reserved)
      await tx
        .update(pendingInputs)
        .set({ runId: run.id, messageId: input.messageId })
        .where(eq(pendingInputs.id, input.id));
    await tx
      .update(runs)
      .set({
        ...checkpointStorage({
          ...run.checkpoint,
          reservedInputs: [
            ...run.checkpoint.reservedInputs,
            ...reserved.filter((input) => !run.checkpoint!.reservedInputs.some((prior) => prior.id === input.id)),
          ],
        }),
        revision: run.revision + 1,
        checkpointRevision: run.revision + 1,
      })
      .where(eq(runs.id, run.id));
    return inputs.map((input, index) => ({
      id: reserved[index]!.messageId,
      role: "user" as const,
      parts: input.payload.blocks.flatMap((block) =>
        block.type === "text" ? [{ type: "text" as const, text: block.text }] : [],
      ),
    }));
  }
  async requestInteraction(claim: RunClaim, input: Extract<Interaction, { kind: "approval" }>) {
    const tx = this.transactionContext();

    const { conversation, run } = await this.ownedClaim(tx, claim);
    if (run.state !== "running") throw new DomainError("CONFLICT", "Run cannot request an interaction");
    if (!run.checkpoint) throw new DomainError("CONFLICT", "Checkpoint unavailable");
    const prior = run.checkpoint.interactions.find((interaction) => interaction.callId === input.callId);
    if (prior) return prior;
    if (run.checkpoint.interactions.length >= 100) throw new DomainError("CONFLICT", "Interaction limit exceeded");
    await tx
      .update(runs)
      .set({
        ...checkpointStorage({ ...run.checkpoint, interactions: [...run.checkpoint.interactions, input] }),
        revision: run.revision + 1,
        checkpointRevision: run.revision + 1,
      })
      .where(eq(runs.id, run.id));
    await this.journal.append(conversation, {
      runId: run.id,
      type: "interaction.changed",
      payload: { interaction: input },
    });
    return input;
  }
  async respond(
    runId: string,
    interactionId: string,
    owner: string,
    expectedRevision: number,
    response: InteractionResponse,
  ) {
    const tx = this.transactionContext();

    const [reference] = await tx.select().from(runs).where(eq(runs.id, runId));
    if (!reference) throw new DomainError("NOT_FOUND", "Run not found");
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, reference.conversationId), eq(conversations.ownerUserId, owner)))
      .for("update");
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
    if (!conversation || !run?.checkpoint) throw new DomainError("NOT_FOUND", "Interaction not found");
    run.checkpoint = (await readCheckpoint(tx, run))!;
    const interaction = run.checkpoint.interactions.find((item) => item.id === interactionId);
    if (!interaction) throw new DomainError("NOT_FOUND", "Interaction not found");
    if (interaction.response) {
      if (
        interaction.acceptedRevision === expectedRevision &&
        fingerprint(interaction.response) === fingerprint(response)
      )
        return publicInteraction(interaction);
      throw new DomainError("CONFLICT", "Interaction response changed");
    }
    if (
      interaction.revision !== expectedRevision ||
      interaction.state !== "pending" ||
      conversation.activeRunId !== run.id ||
      (interaction.expiresAt && Date.parse(interaction.expiresAt) <= Date.now()) ||
      !["running", "waiting"].includes(run.state)
    )
      throw new DomainError("CONFLICT", "Interaction expired or changed");
    if (!validInteractionResponse(interaction, response))
      throw new DomainError("VALIDATION_ERROR", "Response is not allowed");
    const resolved = {
      ...interaction,
      state: "resolved" as const,
      revision: interaction.revision + 1,
      response,
      acceptedRevision: expectedRevision,
    };
    const checkpoint = {
      ...run.checkpoint,
      interactions: run.checkpoint.interactions.map((item) => (item.id === interactionId ? resolved : item)),
    };
    if (
      interaction.kind === "approval" &&
      response.kind === "approval" &&
      response.decision === "allow" &&
      response.scope === "session"
    ) {
      checkpoint.approvals = [...new Set([...checkpoint.approvals, interaction.toolName])];
      conversation.metadata = {
        ...conversation.metadata,
        toolApprovals: {
          environment: environmentKey(conversation, checkpoint.configuration),
          names: checkpoint.approvals,
        },
      };
      await tx
        .update(conversations)
        .set({ metadata: conversation.metadata })
        .where(eq(conversations.id, conversation.id));
    }
    await tx
      .update(runs)
      .set({ ...checkpointStorage(checkpoint), revision: run.revision + 1, checkpointRevision: run.revision + 1 })
      .where(eq(runs.id, run.id));
    await this.journal.append(conversation, {
      runId: run.id,
      type: "interaction.changed",
      payload: { interaction: publicInteraction(resolved) },
    });
    await this.journal.wake(conversation.id, "response:" + run.id + ":" + interactionId);
    return publicInteraction(resolved);
  }
  async suspend(claim: RunClaim, kind: "waiting" | "paused" = "waiting") {
    const tx = this.transactionContext();

    const { conversation, run } = await this.ownedClaim(tx, claim);
    if (!run.checkpoint?.continuation) throw new DomainError("CONFLICT", "Waiting checkpoint is missing");
    const cancelling = run.state === "cancelling";
    await tx
      .update(runs)
      .set({ state: cancelling ? "cancelling" : kind, workerId: null, leaseUntil: null })
      .where(eq(runs.id, run.id));
    await this.journal.append(conversation, {
      runId: run.id,
      type: "run.changed",
      payload: {
        run: {
          id: run.id,
          state: cancelling ? "cancelling" : kind,
          ...(!cancelling && kind === "waiting" ? { waiting: "interaction" as const } : {}),
        },
      },
    });
    // A response can arrive before the worker releases its slot.
    if (cancelling || !run.checkpoint.interactions.some((interaction) => interaction.state === "pending"))
      await this.journal.wake(conversation.id, "released:" + run.id + ":" + run.revision);
  }
  async cancel(runId: string, owner: string) {
    const tx = this.transactionContext();

    const [reference] = await tx.select().from(runs).where(eq(runs.id, runId));
    if (!reference) throw new DomainError("NOT_FOUND", "Run not found");
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, reference.conversationId), eq(conversations.ownerUserId, owner)))
      .for("update");
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
    if (!conversation || !run) throw new DomainError("NOT_FOUND", "Run not found");
    if (!isActiveRun(run.state) || run.state === "cancelling") return runView(run);
    await tx.update(runs).set({ state: "cancelling", updatedAt: new Date() }).where(eq(runs.id, run.id));
    await this.journal.append(conversation, {
      runId: run.id,
      type: "run.changed",
      payload: { run: { id: run.id, state: "cancelling" } },
    });
    await this.journal.wake(conversation.id, "cancel:" + run.id);
    return { id: run.id, state: "cancelling" as const };
  }
  async finish(claim: RunClaim, state: RunState, reason?: string) {
    const tx = this.transactionContext();

    const { conversation, run } = await this.ownedClaim(tx, claim);
    if (run.state === "cancelling") state = "cancelled";
    const unknown = run.checkpoint?.executions.some(
      (entry) => entry.result?.outcome === "unknown" || (!entry.result && entry.dispatch === "dispatched"),
    );
    if (unknown) state = "cancelled_unconfirmed";
    const specExecution = run.checkpoint?.specExecution;
    if (specExecution?.kind === "task") {
      const [attempt] = await tx.select().from(specTaskAttempts).where(and(
        eq(specTaskAttempts.id, specExecution.attemptId),
        eq(specTaskAttempts.specId, specExecution.specId),
        eq(specTaskAttempts.revision, specExecution.revision),
        eq(specTaskAttempts.taskKey, specExecution.taskKey),
      )).for("update");
      if (attempt && !attempt.releasedAt && state !== "cancelled_unconfirmed") {
        if (state === "succeeded") {
          const [version] = await tx.select().from(specRevisions).where(and(
            eq(specRevisions.specId, specExecution.specId), eq(specRevisions.revision, specExecution.revision),
          )).for("update");
          const task = version?.taskPlan.find((item) => item.key === specExecution.taskKey);
          if (version && task && !version.acceptance) {
            const checks = task.checks.filter((check) => check.method.kind === "command");
            const matches = (execution: NonNullable<typeof run.checkpoint>["executions"][number], check: (typeof checks)[number]) => {
              if (check.method.kind !== "command" || execution.name !== "bash") return false;
              const input = execution.input as { command?: unknown; args?: unknown; cwd?: unknown };
              if (input.command !== check.method.command || JSON.stringify(input.args) !== JSON.stringify(check.method.args)) return false;
              return check.method.cwd === undefined
                ? input.cwd === undefined || input.cwd === conversation.metadata.binding?.canonicalCwd
                : input.cwd === check.method.cwd || input.cwd === `${conversation.metadata.binding?.canonicalCwd.replace(/\\/g, "/").replace(/\/$/, "")}/${check.method.cwd.replace(/^\//, "")}`;
            };
            const isCheckCall = (execution: NonNullable<typeof run.checkpoint>["executions"][number]) => checks.some((check) => matches(execution, check));
            const lastImplementationWrite = run.checkpoint!.executions.reduce((last, execution, index) =>
              execution.effects !== "read" && !isCheckCall(execution) ? index : last, -1);
            const evidence = [...version.evidence];
            for (const check of checks) {
              const matching = run.checkpoint!.executions.map((execution, index) => ({ execution, index }))
                .filter(({ execution }) => matches(execution, check)).at(-1);
              if (!matching || matching.index <= lastImplementationWrite || !matching.execution.result ||
                matching.execution.result.status !== "succeeded" || matching.execution.result.outcome === "unknown") continue;
              const value = matching.execution.result.value;
              if (!value || typeof value !== "object" || Array.isArray(value) || value.exitCode !== 0) continue;
              if (evidence.some((item) => item.attemptId === attempt.id && item.checkKey === check.key && item.toolOperationId === matching.execution.executionId)) continue;
              evidence.push({ id: randomUUID(), taskKey: task.key, checkKey: check.key, passed: true, source: "automatic", attemptId: attempt.id, toolOperationId: matching.execution.executionId, createdBy: conversation.ownerUserId, createdAt: new Date().toISOString() });
            }
            if (evidence.length !== version.evidence.length)
              await tx.update(specRevisions).set({ evidence }).where(and(eq(specRevisions.specId, specExecution.specId), eq(specRevisions.revision, specExecution.revision)));
          }
        }
        await tx.update(specTaskAttempts).set({ releasedAt: new Date() }).where(and(eq(specTaskAttempts.id, attempt.id), isNull(specTaskAttempts.releasedAt)));
      }
    }
    if (specExecution && specExecution.kind !== "task" && state === "succeeded") {
      const [spec] = await tx.select().from(specs).where(eq(specs.id, specExecution.specId)).for("update");
      if (spec && spec.conversationId === conversation.id && conversation.metadata.specId === spec.id) {
        const [base] = await tx.select().from(specRevisions).where(and(
          eq(specRevisions.specId, specExecution.specId), eq(specRevisions.revision, specExecution.revision),
        )).limit(1);
        const submitted = run.checkpoint?.executions.filter((execution) =>
          execution.name === "spec_update" && execution.result?.status === "succeeded" &&
          execution.result.outcome !== "unknown").at(-1);
        const output = specDraftCandidateSchema.safeParse(submitted?.result?.value);
        const stage = specExecution.kind === "generation" ? specExecution.stage : output.data?.stage;
        let assistantText: string | undefined;
        if (output.success && output.data.baseRevision === specExecution.revision && output.data.stage === stage)
          assistantText = output.data.content;
        // Older queued generation Runs can still settle their final Markdown response.
        if (!submitted && specExecution.kind === "generation") assistantText = run.projection?.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.blocks.filter((block) => block.type === "text").map((block) => block.text).join(""))
          .filter(Boolean).at(-1)?.trim();
        if (stage === "design" && base?.reviews.requirements?.revision !== specExecution.revision) assistantText = undefined;
        if (stage === "tasks" && (base?.reviews.requirements?.revision !== specExecution.revision || base.reviews.design?.revision !== specExecution.revision)) assistantText = undefined;
        let candidate: string | import("../../../database/schema/spec-revision.table.js").SpecTask[] | null = null;
        if (base && spec.currentRevision === specExecution.revision && assistantText && Buffer.byteLength(assistantText) <= 131072) {
          try {
            if (stage === "requirements") {
              const criteria = acceptanceCriteriaIn(assistantText);
              if (criteria.length && new Set(criteria).size === criteria.length) candidate = assistantText;
            } else if (stage === "design") {
              if (assistantText.trim()) candidate = assistantText;
            } else {
              const jsonText = assistantText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
              const parsed = taskPlanSchema.safeParse(JSON.parse(jsonText));
              if (parsed.success) {
                validateTaskPlan(parsed.data, acceptanceCriteriaIn(base.requirementsMd));
                candidate = parsed.data;
              }
            }
          } catch {
            // Keep malformed model output in the Run transcript; never replace the saved draft.
          }
        }
        if (base && stage && candidate !== null && spec.currentRevision === specExecution.revision) {
          const next = specExecution.revision + 1;
          const carryReview = (review: NonNullable<typeof base.reviews.requirements>) => ({ ...review, revision: next, sourceRevision: review.sourceRevision ?? base.revision });
          const reviews: typeof base.reviews = {};
          if (stage !== "requirements" && base.reviews.requirements) reviews.requirements = carryReview(base.reviews.requirements);
          if (stage === "tasks" && base.reviews.design) reviews.design = carryReview(base.reviews.design);
          const nextRequirements = stage === "requirements" && typeof candidate === "string" ? candidate : base.requirementsMd;
          const nextDesign = stage === "design" && typeof candidate === "string" ? candidate : base.designMd;
          const nextTaskPlan = stage === "tasks" && Array.isArray(candidate) ? candidate : base.taskPlan;
          const same = nextRequirements === base.requirementsMd && nextDesign === base.designMd && JSON.stringify(nextTaskPlan) === JSON.stringify(base.taskPlan);
          if (!same) {
            await tx.insert(specRevisions).values({ specId: spec.id, revision: next, requirementsMd: nextRequirements, designMd: nextDesign, taskPlan: nextTaskPlan, reviews, evidence: [], acceptance: null, createdBy: conversation.ownerUserId });
            await tx.update(specs).set({ currentRevision: next, updatedAt: new Date() }).where(eq(specs.id, spec.id));
            spec.currentRevision = next;
          }
        }
        await this.journal.append(conversation, { runId: run.id, type: "spec.changed", payload: { specId: spec.id, revision: spec.currentRevision, change: "draft" } });
      }
    }
    for (const draft of run.projection?.messages.filter((message) => message.state === "streaming") ?? []) {
      const message = {
        ...draft,
        state:
          state === "succeeded"
            ? ("completed" as const)
            : state.startsWith("cancelled")
              ? ("cancelled" as const)
              : ("failed" as const),
      };
      await insertMessage(tx, conversation.id, { ...message, runId: run.id });
      await this.journal.append(conversation, { runId: run.id, type: "message.committed", payload: { message } });
    }
    const checkpoint = run.checkpoint
      ? {
          ...run.checkpoint,
          interactions: run.checkpoint.interactions.map((item) =>
            item.state === "pending" ? { ...item, state: "cancelled" as const, revision: item.revision + 1 } : item,
          ),
        }
      : null;
    const rejected = await tx
      .update(pendingInputs)
      .set({ status: "rejected" })
      .where(
        and(
          eq(pendingInputs.conversationId, conversation.id),
          eq(pendingInputs.status, "queued"),
          or(eq(pendingInputs.runId, run.id), eq(pendingInputs.mode, "steer")),
        ),
      )
      .returning();
    for (const input of rejected)
      await this.journal.append(conversation, {
        runId: run.id,
        type: "input.rejected",
        payload: {
          input: queuedInput(input),
          error: { code: "INPUT_NOT_COMMITTED", message: "本轮已结束，这条调整尚未应用，请重新发送。" },
        },
      });
    if (checkpoint)
      for (const interaction of checkpoint.interactions.filter((item) => item.state === "cancelled"))
        await this.journal.append(conversation, {
          runId: run.id,
          type: "interaction.changed",
          payload: { interaction: publicInteraction(interaction) },
        });
    await tx
      .update(runs)
      .set({
        state,
        failureReason: reason ?? null,
        ...checkpointStorage(checkpoint),
        checkpointRevision: run.revision,
        workerId: null,
        leaseUntil: null,
        phase: "finalizing",
        updatedAt: new Date(),
      })
      .where(eq(runs.id, run.id));
    await tx.delete(sessionCommits).where(eq(sessionCommits.runId, run.id));
    conversation.activeRunId = null;
    const goal = conversation.metadata.goal;
    if (goal && goal.status !== "completed") {
      conversation.metadata = {
        ...conversation.metadata,
        goal: { ...goal, status: "paused", revision: goal.revision + 1 },
      };
      await this.journal.append(conversation, {
        runId: run.id,
        type: "goal.changed",
        payload: { goal: conversation.metadata.goal ?? null },
      });
    }
    await tx
      .update(conversations)
      .set({ activeRunId: null, metadata: conversation.metadata })
      .where(eq(conversations.id, conversation.id));
    await this.journal.append(conversation, {
      runId: run.id,
      type: "run.changed",
      payload: { run: { id: run.id, state, ...(reason ? { reason } : {}) } },
    });
    if (specExecution?.kind === "task")
      await this.journal.append(conversation, {
        runId: run.id,
        type: "spec.changed",
        payload: { specId: specExecution.specId, revision: specExecution.revision, change: "evidence" },
      });
    if (!unknown) await this.journal.wake(conversation.id, "finished:" + run.id);
  }
  async goalIteration(claim: RunClaim, complete = false) {
    const tx = this.transactionContext();

    const { conversation, run } = await this.ownedClaim(tx, claim);
    const goal = conversation.metadata.goal;
    if (!goal) return null;
    if (goal.status !== "active") throw new DomainError("CONFLICT", "Goal is not active");
    const next = {
      ...goal,
      iterations: complete ? goal.iterations : goal.iterations + 1,
      status: complete ? ("completed" as const) : goal.status,
      revision: goal.revision + 1,
    };
    conversation.metadata = { ...conversation.metadata, goal: next };
    await tx
      .update(conversations)
      .set({ metadata: conversation.metadata })
      .where(eq(conversations.id, conversation.id));
    await this.journal.append(conversation, { runId: run.id, type: "goal.changed", payload: { goal: next } });
    return next;
  }
  async replacePlan(claim: RunClaim, plan: import("@nova/agent-ui-contracts").Todo[]) {
    const tx = this.transactionContext();

    const { conversation, run } = await this.ownedClaim(tx, claim);
    conversation.metadata = { ...conversation.metadata, plan };
    await tx
      .update(conversations)
      .set({ metadata: conversation.metadata })
      .where(eq(conversations.id, conversation.id));
    await this.journal.append(conversation, { runId: run.id, type: "plan.changed", payload: { plan } });
  }
  async recover() {
    await this.db.execute(
      sql`insert into jobs(kind,aggregate_id,dedupe_key,payload,status,available_at,max_attempts) select 'run.wake',conversation_id,'recover:' || id || ':' || revision,jsonb_build_object('conversationId',conversation_id),'queued',now(),5 from runs where state in ('running','waiting','cancelling') and (lease_until is null or lease_until<now()) on conflict(kind,aggregate_id,dedupe_key) do update set status=case when jobs.status='running' then jobs.status else 'queued' end,available_at=now()`,
    );
  }
}
/** Committed message row; the source column stays NULL unless the message carries one. */
async function insertMessage(tx: Transaction, conversationId: string, message: Message) {
  await tx.insert(messages).values({
    id: message.id,
    conversationId,
    runId: message.runId,
    sequence: BigInt(message.sequence),
    role: message.role,
    state: message.state,
    blocks: message.blocks,
    source: message.source ?? null,
    createdAt: new Date(message.createdAt),
  });
}
function checkpointStorage(checkpoint: Checkpoint | null) {
  if (!checkpoint) return { checkpoint, checkpointMetadata: null };
  const { nativeState: _nativeState, executions: _executions, ...metadata } = checkpoint;
  return { checkpoint, checkpointMetadata: metadata };
}
function executionEffectState(executions: readonly import("@nnova/harness").ExecutionRecord[]): RunRow["effectState"] {
  const effects = executions.filter((entry) => entry.effects !== "read");
  if (effects.some((entry) => entry.result?.outcome === "unknown")) return "unknown";
  return effects.some((entry) => !entry.result && entry.dispatch === "dispatched") ? "pending" : "known";
}
function environmentKey(conversation: ConversationRow, configuration: SubmitInput["configuration"]) {
  const binding = conversation.metadata.binding;
  const remoteId = binding?.remoteConnectionId ?? configuration?.remoteConnectionId;
  return remoteId
    ? "ssh:" + remoteId
    : binding?.runnerId
      ? "runner:" + binding.runnerId + ":" + binding.workspaceId
      : "none";
}

async function environmentUnsettled(
  tx: Transaction,
  conversation: ConversationRow,
  configuration: SubmitInput["configuration"],
) {
  const environment = environmentKey(conversation, configuration);
  if (environment === "none") return false;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${environment}))`);
  const rows = await tx.execute(sql`
 select r.id from runs r join conversations c on c.id=r.conversation_id
 where c.owner_user_id=${conversation.ownerUserId}::uuid
 and (case when coalesce(c.metadata->'binding'->>'remoteConnectionId',r.checkpoint->'configuration'->>'remoteConnectionId',c.metadata->'configuration'->>'remoteConnectionId') is not null
 then 'ssh:' || coalesce(c.metadata->'binding'->>'remoteConnectionId',r.checkpoint->'configuration'->>'remoteConnectionId',c.metadata->'configuration'->>'remoteConnectionId')
 when c.metadata->'binding'->>'runnerId' is not null then 'runner:' || (c.metadata->'binding'->>'runnerId') || ':' || (c.metadata->'binding'->>'workspaceId') else 'none' end)=${environment}
 and (r.state='cancelled_unconfirmed' or r.effect_state='unknown' or (r.effect_state='pending' and (r.lease_until is null or r.lease_until<now()))) limit 1
 `);
  return rows.rows.length > 0;
}

export const runRepository = defineRepository(
  { journal: runJournal, events: eventWriter, projection: runProjectionReader },
  ({ db, requireTransaction, journal, events, projection }) =>
    new RunRepository(db, requireTransaction, journal, events, projection),
);
export function createRunRepository(db: Database) {
  return createScope(db).get(runRepository);
}
