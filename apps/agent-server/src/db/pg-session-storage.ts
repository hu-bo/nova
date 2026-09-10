import { projectBlock } from "../modules/projection/project-agent-events.js";
import { projectToolDetails } from "../modules/projection/tool-blocks.js";
import type { Block } from "@nova/protocol";
import { and, asc, desc, eq, sql, gte } from "drizzle-orm";
import { CheckpointConflict, type Entry, type EntryId, type SessionStorage } from "@nova/agent-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { entries, records, runs, messages } from "./schema.js";

export function pgSessionStorage<TSchema extends Record<string, unknown>>(
  db: PostgresJsDatabase<TSchema>,
  conversationId: string,
): SessionStorage {
  return {
    async loadCheckpoint(sessionId) {
      assertSession(sessionId, conversationId);
      const [row] = await db
        .select({ payload: runs.payload })
        .from(runs)
        .where(eq(runs.conversationId, conversationId));
      return row?.payload ?? null;
    },
    async commit(sessionId, change) {
      assertSession(sessionId, conversationId);
      await db.transaction(async (tx) => {
        const cp = change.checkpoint;
        const values = {
          conversationId,
          runId: cp.runId,
          version: cp.version,
          status: cp.status,
          reason: cp.reason,
          payload: cp,
          updatedAt: new Date(),
        };
        const changed =
          change.expectedVersion === null
            ? await tx.insert(runs).values(values).onConflictDoNothing().returning({ version: runs.version })
            : await tx
                .update(runs)
                .set(values)
                .where(and(eq(runs.conversationId, conversationId), eq(runs.version, change.expectedVersion)))
                .returning({ version: runs.version });
        if (!changed.length) throw new CheckpointConflict();
        const fact = change.record;
        const value = change.entry;
        if (value)
          await tx.insert(entries).values({
            conversationId,
            id: value.id,
            parentId: value.parentId,
            kind: value.kind,
            payload: value,
            createdAt: new Date(value.ts),
          });
        if (fact)
          await tx.insert(records).values({
            conversationId,
            id: fact.id,
            runId: fact.runId,
            kind: fact.kind,
            payload: fact,
            createdAt: new Date(fact.ts),
          });
        const message = value?.kind === "message" && value.message.role === "assistant" ? value.message : cp.draft;
        if (message) {
          const blocks = message.blocks.flatMap((block) => {
            const projected = projectBlock(block);
            return projected ? [projected] : [];
          });
          const status = cp.draft
            ? cp.status === "running"
              ? ("streaming" as const)
              : ("aborted" as const)
            : cp.phase === "finish" && cp.completion === "aborted"
              ? ("aborted" as const)
              : cp.phase === "finish" &&
                  cp.completion &&
                  ["error", "repetition_detected", "max_tokens", "max_turns"].includes(cp.completion)
                ? ("error" as const)
                : ("done" as const);
          await tx
            .insert(messages)
            .values({
              conversationId,
              id: message.id,
              role: "assistant",
              blocks,
              status,
              createdAt: new Date(message.createdAt),
            })
            .onConflictDoUpdate({ target: [messages.conversationId, messages.id], set: { blocks, status } });
        }
        if (fact?.kind === "tool-finished") {
          const [row] = await tx
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.conversationId, conversationId),
                eq(messages.role, "assistant"),
                sql`${messages.blocks} @> ${JSON.stringify([{ type: "tool_call", callId: fact.callId }])}::jsonb`,
              ),
            )
            .orderBy(desc(messages.seq))
            .limit(1);
          if (row?.role === "assistant") {
            const call = row.blocks.find((b) => b.type === "tool_call" && b.callId === fact.callId);
            const blocks: Block[] = row.blocks
              .filter((b) => !(b.type === "tool_result" && b.callId === fact.callId))
              .map((b) =>
                b.type === "tool_call" && b.callId === fact.callId
                  ? { ...b, status: fact.status === "ok" ? "ok" : "error" }
                  : b,
              );
            const approvals = await tx
              .select({ payload: records.payload })
              .from(records)
              .where(
                and(
                  eq(records.conversationId, conversationId),
                  eq(records.runId, cp.runId),
                  eq(records.kind, "decision-requested"),
                ),
              )
              .orderBy(desc(records.seq));
            const approval = approvals
              .map((r) => r.payload)
              .find(
                (r) =>
                  r.kind === "decision-requested" && r.request.kind === "approval" && r.request.callId === fact.callId,
              );
            const changes =
              approval?.kind === "decision-requested" && approval.request.kind === "approval"
                ? approval.request.codeChanges
                : undefined;
            blocks.push({
              type: "tool_result",
              callId: fact.callId,
              status: fact.status,
              blocks:
                fact.details !== undefined
                  ? projectToolDetails(call?.type === "tool_call" ? call.name : "tool", fact.details, changes)
                  : (fact.content ?? []).flatMap((p) =>
                      p.type === "text" ? [{ type: "text" as const, text: p.text }] : [],
                    ),
            });
            await tx
              .update(messages)
              .set({ blocks })
              .where(and(eq(messages.conversationId, conversationId), eq(messages.id, row.id)));
          }
        }
        if (cp.status !== "running") {
          const unfinished = await tx
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.conversationId, conversationId),
                eq(messages.role, "assistant"),
                gte(messages.createdAt, new Date(cp.startedAt)),
              ),
            );
          for (const row of unfinished) {
            if (!row.blocks.some((b) => b.type === "tool_call" && b.status === "running")) continue;
            const blocks: Block[] = row.blocks.map((b) =>
              b.type === "tool_call" && b.status === "running" ? { ...b, status: "cancelled" } : b,
            );
            await tx
              .update(messages)
              .set({ blocks })
              .where(and(eq(messages.conversationId, conversationId), eq(messages.id, row.id)));
          }
        }
        if (cp.status !== "running" || fact?.kind === "run-resumed") {
          await tx
            .update(messages)
            .set({ status: cp.status === "failed" ? "error" : cp.status === "completed" ? "done" : "aborted" })
            .where(and(eq(messages.conversationId, conversationId), eq(messages.status, "streaming")));
        }
      });
    },
    async appendEntry(sessionId, entry) {
      assertSession(sessionId, conversationId);
      await db.insert(entries).values({
        conversationId,
        id: entry.id,
        parentId: entry.parentId,
        kind: entry.kind,
        payload: entry,
        createdAt: new Date(entry.ts),
      });
    },
    async appendRecord(sessionId, record) {
      assertSession(sessionId, conversationId);
      await db.insert(records).values({
        conversationId,
        id: record.id,
        runId: record.runId,
        kind: record.kind,
        payload: record,
        createdAt: new Date(record.ts),
      });
    },
    async loadEntries(sessionId, leafId) {
      assertSession(sessionId, conversationId);
      const rows = await db
        .select({ payload: entries.payload })
        .from(entries)
        .where(eq(entries.conversationId, conversationId))
        .orderBy(asc(entries.seq));
      return branch(
        rows.map((row) => row.payload),
        leafId,
      );
    },
    async loadRecords(sessionId, filter) {
      assertSession(sessionId, conversationId);
      const conditions = [eq(records.conversationId, conversationId)];
      if (filter?.runId) conditions.push(eq(records.runId, filter.runId));
      if (filter?.kind) conditions.push(eq(records.kind, filter.kind));
      return db
        .select({ payload: records.payload })
        .from(records)
        .where(and(...conditions))
        .orderBy(filter?.desc ? desc(records.seq) : asc(records.seq))
        .limit(filter?.limit ?? 2_147_483_647)
        .then((rows) => rows.map((row) => row.payload));
    },
  };
}

function assertSession(sessionId: string, conversationId: string): void {
  if (sessionId !== conversationId) throw new Error("session id does not match conversation id");
}

function branch(all: Entry[], leafId?: EntryId): Entry[] {
  if (all.length === 0) return [];
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  let current: EntryId | null = leafId ?? all[all.length - 1]!.id;
  const result: Entry[] = [];
  while (current !== null) {
    const entry = byId.get(current);
    if (!entry) throw new Error(`entry not found: ${current}`);
    result.push(entry);
    current = entry.parentId;
  }
  return result.reverse();
}
