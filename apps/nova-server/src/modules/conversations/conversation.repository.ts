import { createScope, defineRepository } from "../../shared/scope.js";
import { eventWriter } from "../events/index.js";
import type { Transaction } from "../../shared/unit-of-work.js";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  configurationSchema,
  operationsFromMessages,
  type InputBlock,
  type SubmitInput,
} from "@nova/agent-ui-contracts";
import {
  conversations,
  messages,
  pendingInputs,
  runs,
  specTaskAttempts,
  type Database,
  type ConversationMetadata,
} from "../../../database/index.js";
import {
  runJournal,
  conversationView,
  effectiveCapabilities,
  emptyProjection,
  fingerprint,
  inputReceipt,
  messageDTO,
  publicInteraction,
  queuedInput,
  runProjectionReader,
} from "../runs/index.js";
import { DomainError } from "../../shared/domain-error.js";
import type { RunJournal } from "../runs/index.js";
import type { GoalInput } from "./conversation.schema.js";
export type ConversationRow = typeof conversations.$inferSelect;
const owned = (id: string, owner: string) => and(eq(conversations.id, id), eq(conversations.ownerUserId, owner));
/** Caller holds the conversation row lock. Missing or foreign-owned conversations surface as NOT_FOUND. */
async function lockOwned(tx: Transaction, id: string, owner: string): Promise<ConversationRow> {
  const [conversation] = await tx.select().from(conversations).where(owned(id, owner)).for("update");
  if (!conversation) throw new DomainError("NOT_FOUND", "Conversation not found");
  return conversation;
}
async function messagePage(db: Pick<Database, "select">, id: string, before?: string) {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, id), before ? lt(messages.sequence, BigInt(before)) : undefined))
    .orderBy(desc(messages.sequence))
    .limit(51);
  const items = rows.slice(0, 50).reverse();
  return {
    items: items.map(messageDTO),
    beforeSequence: rows.length > 50 ? items[0]!.sequence.toString() : null,
    operations: operationsFromMessages(items.map(messageDTO)),
  };
}
async function enqueue(
  tx: Transaction,
  conversation: ConversationRow,
  input: SubmitInput & { goal?: GoalInput },
  journal: RunJournal,
  key?: string,
) {
  if (conversation.metadata.specId && (input.mode !== "next_run" || input.goal))
    throw new DomainError("CONFLICT", "Specification sessions accept Plan messages only", { reason: "SPEC_SESSION_RESTRICTED" });
  const normalized = {
    ...input,
    configuration: input.configuration ?? configurationSchema.parse(conversation.metadata.configuration ?? {}),
  };
  if (conversation.metadata.specId) normalized.configuration = { ...normalized.configuration, mode: "plan" };
  const signature = fingerprint(input);
  if (key) {
    const [previous] = await tx
      .select()
      .from(pendingInputs)
      .where(and(eq(pendingInputs.conversationId, conversation.id), eq(pendingInputs.idempotencyKey, key)))
      .limit(1);
    if (previous) {
      if (previous.fingerprint !== signature) throw new DomainError("CONFLICT", "Idempotency payload changed");
      return inputReceipt(previous);
    }
  }
  const queued = await tx
    .select({ id: pendingInputs.id })
    .from(pendingInputs)
    .where(and(eq(pendingInputs.conversationId, conversation.id), eq(pendingInputs.status, "queued")))
    .limit(64);
  if (queued.length >= 64) throw new DomainError("RATE_LIMITED", "Input queue is full");
  if (input.mode === "steer" && (!conversation.activeRunId || input.blocks.some((block) => block.type !== "text")))
    throw new DomainError("CONFLICT", "Steering requires an active run and text content");
  if (
    input.mode === "steer" &&
    fingerprint(normalized.configuration) !== fingerprint(conversation.metadata.configuration)
  )
    throw new DomainError("CONFLICT", "Steering cannot change the active configuration");
  if (input.goal && conversation.activeRunId)
    throw new DomainError("CONFLICT", "Settle the active run before starting a goal");
  const [unknown] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.conversationId, conversation.id), eq(runs.state, "cancelled_unconfirmed")))
    .limit(1);
  if (unknown)
    throw new DomainError("CONFLICT", "Inspect unknown operations before continuing", {
      reason: "EXECUTION_OUTCOME_UNKNOWN",
    });
  if (input.goal && conversation.metadata.goal && conversation.metadata.goal.status !== "completed")
    throw new DomainError("CONFLICT", "Finish or remove the existing goal first", { reason: "GOAL_ALREADY_EXISTS" });
  if (input.goal) {
    conversation.metadata = {
      ...conversation.metadata,
      goal: {
        ...input.goal,
        status: "ready",
        iterations: 0,
        revision: (conversation.metadata.goal?.revision ?? 0) + 1,
      },
    };
    await tx
      .update(conversations)
      .set({ metadata: conversation.metadata })
      .where(eq(conversations.id, conversation.id));
    await journal.append(conversation, {
      runId: null,
      type: "goal.changed",
      payload: { goal: conversation.metadata.goal ?? null },
    });
  }
  const [last] = await tx
    .select({ sequence: pendingInputs.sequence })
    .from(pendingInputs)
    .where(eq(pendingInputs.conversationId, conversation.id))
    .orderBy(desc(pendingInputs.sequence))
    .limit(1);
  const [inputRow] = await tx
    .insert(pendingInputs)
    .values({
      conversationId: conversation.id,
      sequence: (last?.sequence ?? 0n) + 1n,
      mode: input.mode,
      payload: normalized,
      idempotencyKey: key ?? null,
      fingerprint: signature,
    })
    .returning();
  if (!inputRow) throw new Error("Input insert failed");
  await journal.append(conversation, { runId: null, type: "input.queued", payload: { input: queuedInput(inputRow) } });
  await journal.wake(conversation.id, "input:" + inputRow.id);
  return inputReceipt(inputRow);
}
export const conversationRepository = defineRepository(
  { journal: runJournal, projectionReader: runProjectionReader, events: eventWriter },
  ({ db, requireTransaction, journal, projectionReader, events }) => {
    return {
      async create(input: {
        ownerUserId: string;
        mode: "chat" | "project";
        projectId: string | null;
        title: string | null;
        metadata: ConversationMetadata;
        initialInput?: { blocks: InputBlock[] };
        idempotencyKey?: string;
      }) {
        const tx = requireTransaction();

        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.ownerUserId}))`);
        const signature = fingerprint({
          mode: input.mode,
          projectId: input.projectId,
          title: input.title,
          initialInput: input.initialInput,
          configuration: input.metadata.configuration,
          goal: input.metadata.goal,
        });
        if (input.idempotencyKey) {
          const [prior] = await tx
            .select()
            .from(conversations)
            .where(
              and(
                eq(conversations.ownerUserId, input.ownerUserId),
                sql`${conversations.metadata}->>'creationKey'=${input.idempotencyKey}`,
              ),
            )
            .limit(1);
          if (prior) {
            if (prior.metadata.creationPayload !== signature)
              throw new DomainError("CONFLICT", "Idempotency payload changed");
            return prior;
          }
        }
        const [row] = await tx
          .insert(conversations)
          .values({
            ownerUserId: input.ownerUserId,
            mode: input.mode,
            projectId: input.projectId,
            title: input.title,
            metadata: { ...input.metadata, creationKey: input.idempotencyKey ?? null, creationPayload: signature },
          })
          .returning();
        if (!row) throw new Error("Conversation insert failed");
        if (input.initialInput)
          await enqueue(
            tx,
            row,
            { blocks: input.initialInput.blocks, mode: "next_run", configuration: input.metadata.configuration },
            journal,
            "initial:" + row.id,
          );
        return row;
      },
      async findById({ id, ownerUserId }: { id: string; ownerUserId: string }) {
        const [row] = await db.select().from(conversations).where(owned(id, ownerUserId));
        return row;
      },
      async list({ ownerUserId, limit }: { ownerUserId: string; limit: number }) {
        return db
          .select()
          .from(conversations)
          .where(eq(conversations.ownerUserId, ownerUserId))
          .orderBy(desc(conversations.updatedAt), desc(conversations.id))
          .limit(limit);
      },
      async snapshot(id: string, owner: string) {
        const tx = requireTransaction({ isolationLevel: "repeatable read" });

        const [conversation] = await tx.select().from(conversations).where(owned(id, owner));
        if (!conversation) throw new DomainError("NOT_FOUND", "Conversation not found");
        const page = await messagePage(tx, id);
        const runId = conversation.activeRunId ?? conversation.metadata.latestRunId;
        const [run] = runId
          ? await tx
              .select({
                projection: runs.projection,
                interactions: sql<
                  Parameters<typeof publicInteraction>[0][] | null
                >`${runs.checkpointMetadata}->'interactions'`,
              })
              .from(runs)
              .where(and(eq(runs.id, runId), eq(runs.conversationId, id)))
              .limit(1)
          : [];
        const queued = await tx
          .select()
          .from(pendingInputs)
          .where(and(eq(pendingInputs.conversationId, id), eq(pendingInputs.status, "queued")))
          .orderBy(asc(pendingInputs.sequence));
        const projection = run?.projection
          ? await projectionReader.read(conversation, run.projection)
          : emptyProjection(conversation);
        return {
          ...projection,
          conversation: conversationView(conversation),
          cursor: conversation.lastEventSequence.toString(),
          messages: [
            ...page.items,
            ...projection.messages.filter(
              (message) => message.state === "streaming" && !page.items.some((item) => item.id === message.id),
            ),
          ],
          beforeSequence: page.beforeSequence,
          pendingInputs: queued.map(queuedInput),
          interactions: run?.interactions?.map(publicInteraction) ?? [],
          goal: conversation.metadata.goal ?? null,
          plan: conversation.metadata.plan ?? [],
          capabilities: effectiveCapabilities(conversation),
          binding: conversation.metadata.binding ?? null,
        };
      },
      async messages(id: string, owner: string, before?: string) {
        const [row] = await db.select({ id: conversations.id }).from(conversations).where(owned(id, owner));
        if (!row) throw new DomainError("NOT_FOUND", "Conversation not found");
        return messagePage(db, id, before);
      },
      async enqueue(
        input: SubmitInput & { conversationId: string; ownerUserId: string; goal?: GoalInput; idempotencyKey?: string },
      ) {
        const tx = requireTransaction();

        const conversation = await lockOwned(tx, input.conversationId, input.ownerUserId);
        return enqueue(
          tx,
          conversation,
          {
            blocks: input.blocks,
            mode: input.mode,
            ...(input.configuration ? { configuration: input.configuration } : {}),
            ...(input.goal ? { goal: input.goal } : {}),
          },
          journal,
          input.idempotencyKey,
        );
      },
      async removePendingInput(input: { conversationId: string; inputId: string; ownerUserId: string }) {
        const tx = requireTransaction();

        const conversation = await lockOwned(tx, input.conversationId, input.ownerUserId);
        const [row] = await tx
          .select()
          .from(pendingInputs)
          .where(and(eq(pendingInputs.id, input.inputId), eq(pendingInputs.conversationId, conversation.id)));
        if (row?.status === "removed") return;
        if (!row || row.status !== "queued" || row.runId)
          throw new DomainError("CONFLICT", "Input already reserved or consumed");
        await tx.update(specTaskAttempts).set({ releasedAt: new Date() }).where(and(eq(specTaskAttempts.pendingInputId, row.id), isNull(specTaskAttempts.releasedAt)));
        const [removed] = await tx
          .update(pendingInputs)
          .set({ status: "removed", removedAt: new Date() })
          .where(eq(pendingInputs.id, row.id))
          .returning();
        await journal.append(conversation, {
          runId: null,
          type: "input.removed",
          payload: { input: queuedInput(removed!) },
        });
      },
      async steerPendingInput(input: { conversationId: string; inputId: string; ownerUserId: string }) {
        const tx = requireTransaction();

        const conversation = await lockOwned(tx, input.conversationId, input.ownerUserId);
        const [row] = await tx
          .select()
          .from(pendingInputs)
          .where(and(eq(pendingInputs.id, input.inputId), eq(pendingInputs.conversationId, conversation.id)));
        if (
          !row ||
          row.status !== "queued" ||
          row.runId ||
          conversation.metadata.specId ||
          !conversation.activeRunId ||
          !effectiveCapabilities(conversation).steering ||
          row.payload.blocks.some((block) => block.type !== "text")
        )
          throw new DomainError("CONFLICT", "Input cannot become steering");
        if (row.mode === "steer") return inputReceipt(row);
        const [updated] = await tx
          .update(pendingInputs)
          .set({
            mode: "steer",
            payload: {
              ...row.payload,
              mode: "steer",
              configuration: configurationSchema.parse(conversation.metadata.configuration ?? {}),
            },
          })
          .where(eq(pendingInputs.id, row.id))
          .returning();
        await journal.append(conversation, {
          runId: null,
          type: "input.queued",
          payload: { input: queuedInput(updated!) },
        });
        return inputReceipt(updated!);
      },
      async update(id: string, owner: string, title: string) {
        const [row] = await db
          .update(conversations)
          .set({ title, updatedAt: new Date() })
          .where(owned(id, owner))
          .returning();
        if (!row) throw new DomainError("NOT_FOUND", "Conversation not found");
        return row;
      },
      async updateGoal(
        id: string,
        owner: string,
        action: "pause" | "resume" | "complete" | "remove",
        revision: number,
      ) {
        const tx = requireTransaction();

        const conversation = await lockOwned(tx, id, owner);
        if (conversation.metadata.specId) throw new DomainError("CONFLICT", "Goals are disabled in specification sessions", { reason: "SPEC_SESSION_RESTRICTED" });
        const goal = conversation.metadata.goal;
        if (!goal) throw new DomainError("NOT_FOUND", "Goal not found");
        if (goal.revision !== revision)
          throw new DomainError("CONFLICT", "Goal changed", { reason: "REVISION_CONFLICT" });
        if (conversation.activeRunId && action !== "pause")
          throw new DomainError("CONFLICT", "Settle the active run first");
        if (action === "resume" && (goal.status !== "paused" || goal.iterations >= goal.maxIterations))
          throw new DomainError("CONFLICT", "Goal cannot resume");
        if (action === "pause" && goal.status === "completed")
          throw new DomainError("CONFLICT", "Completed goal cannot pause");
        const nextStatus = {
          pause: "paused",
          resume: "ready",
          complete: "completed",
        } satisfies Record<Exclude<typeof action, "remove">, NonNullable<ConversationMetadata["goal"]>["status"]>;
        const next =
          action === "remove"
            ? null
            : {
                ...goal,
                revision: goal.revision + 1,
                status: nextStatus[action],
              };
        conversation.metadata = { ...conversation.metadata, goal: next };
        await tx.update(conversations).set({ metadata: conversation.metadata }).where(eq(conversations.id, id));
        await journal.append(conversation, { runId: null, type: "goal.changed", payload: { goal: next } });
        if (action === "resume") await journal.wake(id, "goal:" + id + ":" + next!.revision);
        return next;
      },
      async maintain(id: string, owner: string, action: "clear" | "delete") {
        const tx = requireTransaction();

        const conversation = await lockOwned(tx, id, owner);
        const [unknown] = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.conversationId, id), eq(runs.state, "cancelled_unconfirmed")))
          .limit(1);
        if (conversation.activeRunId || unknown)
          throw new DomainError("CONFLICT", "Settle the active or unknown run first");
        if (conversation.metadata.specId)
          throw new DomainError("CONFLICT", "Specification sessions are maintained from the project specification", { reason: "SPEC_SESSION_RESTRICTED" });
        if (action === "delete") {
          await tx.delete(pendingInputs).where(eq(pendingInputs.conversationId, id));
          await tx.delete(messages).where(eq(messages.conversationId, id));
          await events.deleteConversation(id);
          await tx.delete(runs).where(eq(runs.conversationId, id));
          await tx.delete(conversations).where(owned(id, owner));
          return null;
        }
        conversation.contextEpoch++;
        conversation.metadata = {
          ...conversation.metadata,
          latestCheckpointRunId: null,
          plan: [],
          toolApprovals: null,
        };
        await tx
          .update(conversations)
          .set({ contextEpoch: conversation.contextEpoch, metadata: conversation.metadata })
          .where(eq(conversations.id, id));
        await journal.append(conversation, {
          runId: null,
          type: "context.changed",
          payload: { epoch: conversation.contextEpoch, action: "clear" },
        });
        return { epoch: conversation.contextEpoch };
      },
    };
  },
);
export function createConversationRepository(db: Database) {
  return createScope(db).get(conversationRepository);
}
export type ConversationRepository = ReturnType<typeof createConversationRepository>;
