import { and, desc, eq, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Page } from "@nova/protocol";
import { conflict, invalidInput, notFound } from "../errors.js";
import type { AgentStore } from "../store.js";
import { conversations, messages, projects, runners as runnerRecords, runnerTokens, users } from "./schema.js";

export interface PgStore {
  store: AgentStore;
  db: ReturnType<typeof drizzle>;
  checkConnection(): Promise<void>;
  close(): Promise<void>;
}

export function createPgStore(databaseUrl: string): PgStore {
  const client = postgres(databaseUrl, { max: 10 });
  const db = drizzle(client);

  const store: AgentStore = {
    async upsertUser(profile) {
      const [user] = await db
        .insert(users)
        .values(profile)
        .onConflictDoUpdate({
          target: users.casdoorId,
          set: {
            username: profile.username,
            displayName: profile.displayName,
            role: profile.role,
            isAdmin: profile.isAdmin,
            isActive: profile.isActive,
            updatedAt: new Date(),
          },
        })
        .returning();
      return user!;
    },
    async getUser(casdoorId) {
      const [user] = await db.select().from(users).where(eq(users.casdoorId, casdoorId)).limit(1);
      return user ?? null;
    },
    async ensureRunnerToken(input) {
      const [existing] = await db
        .select()
        .from(runnerTokens)
        .where(eq(runnerTokens.userId, input.userId))
        .orderBy(runnerTokens.slot)
        .limit(1);
      if (existing) return existing;
      await db
        .insert(runnerTokens)
        .values({ ...input, slot: 1 })
        .onConflictDoNothing({
          target: [runnerTokens.userId, runnerTokens.slot],
        });
      const [token] = await db
        .select()
        .from(runnerTokens)
        .where(eq(runnerTokens.userId, input.userId))
        .orderBy(runnerTokens.slot)
        .limit(1);
      if (!token) throw conflict("Unable to create the initial runner token");
      return token;
    },
    async createRunnerToken(input) {
      try {
        return await db.transaction(async (tx) => {
          const existing = await tx
            .select({ slot: runnerTokens.slot })
            .from(runnerTokens)
            .where(eq(runnerTokens.userId, input.userId));
          const used = new Set(existing.map((item) => item.slot));
          const slot = [1, 2, 3].find((value) => !used.has(value));
          if (!slot) throw conflict("Each user can create up to 3 runner tokens");
          const [token] = await tx
            .insert(runnerTokens)
            .values({ ...input, slot })
            .returning();
          return token!;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("Runner token creation conflicted; please retry");
        throw error;
      }
    },
    async listRunnerTokens(userId) {
      return db.select().from(runnerTokens).where(eq(runnerTokens.userId, userId)).orderBy(runnerTokens.slot);
    },
    async findRunnerToken(token) {
      const [row] = await db.select().from(runnerTokens).where(eq(runnerTokens.token, token)).limit(1);
      return row ?? null;
    },
    async deleteRunnerToken(input) {
      return db.transaction(async (tx) => {
        const [token] = await tx
          .select({ id: runnerTokens.id })
          .from(runnerTokens)
          .where(and(eq(runnerTokens.id, input.id), eq(runnerTokens.userId, input.userId)))
          .for("update")
          .limit(1);
        if (!token) throw notFound("Runner token");
        const bound = await tx
          .select({ id: runnerRecords.id })
          .from(runnerRecords)
          .where(and(eq(runnerRecords.ownerId, input.userId), eq(runnerRecords.tokenId, input.id)));
        if (!bound.length) await tx.delete(runnerTokens).where(eq(runnerTokens.id, input.id));
        return bound.map((item) => item.id).sort();
      });
    },
    async upsertRunner(input) {
      const [runner] = await db
        .insert(runnerRecords)
        .values({ ...input, registeredAt: new Date(), lastSeenAt: new Date() })
        .onConflictDoUpdate({
          target: [runnerRecords.ownerId, runnerRecords.id],
          set: {
            tokenId: input.tokenId,
            generation: input.generation,
            rootWorkspace: input.rootWorkspace,
            version: input.version,
            platform: input.platform,
            capabilities: input.capabilities,
            labels: input.labels,
            maxConcurrency: input.maxConcurrency,
            running: input.running,
            reportedState: input.reportedState,
            lastSeenAt: new Date(),
          },
        })
        .returning();
      return runner!;
    },
    async updateRunnerStatus(input) {
      await db
        .update(runnerRecords)
        .set({
          running: input.running,
          reportedState: input.reportedState,
          lastSeenAt: input.lastSeenAt,
        })
        .where(and(eq(runnerRecords.ownerId, input.ownerId), eq(runnerRecords.id, input.id)));
    },
    async listRunners(input) {
      const cursor = input.cursor ? decodeCursor<{ lastSeenAt: string; id: string }>(input.cursor) : undefined;
      const filters = [eq(runnerRecords.ownerId, input.userId)];
      if (cursor) {
        const timestamp = new Date(cursor.lastSeenAt);
        if (Number.isNaN(timestamp.getTime())) throw invalidInput("Invalid runner cursor");
        filters.push(
          or(
            lt(runnerRecords.lastSeenAt, timestamp),
            and(eq(runnerRecords.lastSeenAt, timestamp), lt(runnerRecords.id, cursor.id)),
          )!,
        );
      }
      const rows = await db
        .select()
        .from(runnerRecords)
        .where(and(...filters))
        .orderBy(desc(runnerRecords.lastSeenAt), desc(runnerRecords.id))
        .limit(input.limit + 1);
      return page(rows, input.limit, (item) =>
        encodeCursor({ lastSeenAt: item.lastSeenAt.toISOString(), id: item.id }),
      );
    },
    async listRunnerIdsByToken(input) {
      const rows = await db
        .select({ id: runnerRecords.id })
        .from(runnerRecords)
        .where(and(eq(runnerRecords.ownerId, input.userId), eq(runnerRecords.tokenId, input.tokenId)))
        .orderBy(runnerRecords.id);
      return rows.map((item) => item.id);
    },
    async deleteRunner(input) {
      const deleted = await db
        .delete(runnerRecords)
        .where(and(eq(runnerRecords.ownerId, input.userId), eq(runnerRecords.id, input.id)))
        .returning({ id: runnerRecords.id });
      if (!deleted.length) throw notFound("Runner");
    },
    async createProject(input) {
      const [project] = await db.insert(projects).values(input).returning();
      return project!;
    },
    async listProjects(userId) {
      return db
        .select()
        .from(projects)
        .where(eq(projects.userId, userId))
        .orderBy(desc(projects.updatedAt), desc(projects.id));
    },
    async updateProject(input) {
      const [project] = await db
        .update(projects)
        .set({ name: input.name, updatedAt: new Date() })
        .where(and(eq(projects.id, input.id), eq(projects.userId, input.userId)))
        .returning();
      if (!project) throw notFound("Project");
      return project;
    },
    async bindProject(input) {
      try {
        const [project] = await db
          .update(projects)
          .set({ runnerId: input.runnerId, workspace: input.workspace, updatedAt: new Date() })
          .where(and(eq(projects.id, input.id), eq(projects.userId, input.userId)))
          .returning();
        if (!project) throw notFound("Project");
        return project;
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("A project already uses this runner workspace");
        throw error;
      }
    },
    async deleteProject(input) {
      const deleted = await db
        .delete(projects)
        .where(and(eq(projects.id, input.id), eq(projects.userId, input.userId)))
        .returning({ id: projects.id });
      if (deleted.length === 0) throw notFound("Project");
    },
    async createConversation(input) {
      if (input.projectId) {
        const [project] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, input.projectId), eq(projects.userId, input.userId)))
          .limit(1);
        if (!project) throw notFound("Project");
      }
      const [conversation] = await db.insert(conversations).values(input).returning();
      return conversation!;
    },
    async listConversations(input) {
      const cursor = input.cursor ? decodeCursor<{ updatedAt: string; id: string }>(input.cursor) : undefined;
      const filters = [eq(conversations.userId, input.userId)];
      if (input.projectId !== undefined) filters.push(eq(conversations.projectId, input.projectId));
      if (cursor) {
        const timestamp = new Date(cursor.updatedAt);
        if (Number.isNaN(timestamp.getTime())) throw invalidInput("Invalid conversation cursor");
        filters.push(
          or(
            lt(conversations.updatedAt, timestamp),
            and(eq(conversations.updatedAt, timestamp), lt(conversations.id, cursor.id)),
          )!,
        );
      }
      const rows = await db
        .select()
        .from(conversations)
        .where(and(...filters))
        .orderBy(desc(conversations.updatedAt), desc(conversations.id))
        .limit(input.limit + 1);
      return page(rows, input.limit, (item) => encodeCursor({ updatedAt: item.updatedAt.toISOString(), id: item.id }));
    },
    async routeConversation(userId, id) {
      const [conversation] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
        .limit(1);
      if (!conversation) throw notFound("Conversation");
      if (!conversation.projectId) return { userId, conversation, project: null };
      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, conversation.projectId), eq(projects.userId, userId)))
        .limit(1);
      if (!project) throw notFound("Project");
      return { userId, conversation, project };
    },
    async updateConversationRunner(input) {
      const [conversation] = await db
        .update(conversations)
        .set({ runnerId: input.runnerId, updatedAt: new Date() })
        .where(and(eq(conversations.id, input.id), eq(conversations.userId, input.userId)))
        .returning();
      if (!conversation) throw notFound("Conversation");
      return conversation;
    },
    async setConversationTitleIfUntitled(input) {
      await db
        .update(conversations)
        .set({ title: input.title })
        .where(
          and(
            eq(conversations.id, input.id),
            eq(conversations.userId, input.userId),
            eq(conversations.title, "New conversation"),
          ),
        );
    },
    async updateConversationModel(input) {
      const [conversation] = await db
        .update(conversations)
        .set({ modelConfig: input.modelConfig, updatedAt: new Date() })
        .where(and(eq(conversations.id, input.id), eq(conversations.userId, input.userId)))
        .returning();
      if (!conversation) throw notFound("Conversation");
      return conversation;
    },
    async appendMessage(input) {
      return db.transaction(async (tx) => {
        const [message] = await tx.insert(messages).values(input).returning();
        await tx
          .update(conversations)
          .set({ updatedAt: input.createdAt })
          .where(eq(conversations.id, input.conversationId));
        return message!;
      });
    },
    async listMessages(input) {
      const [owned] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.userId, input.userId)))
        .limit(1);
      if (!owned) throw notFound("Conversation");
      const cursor = input.before ? decodeCursor<{ createdAt: string; seq: number }>(input.before) : undefined;
      const filters = [eq(messages.conversationId, input.conversationId)];
      if (cursor) {
        const timestamp = new Date(cursor.createdAt);
        if (Number.isNaN(timestamp.getTime())) throw invalidInput("Invalid message cursor");
        filters.push(
          or(lt(messages.createdAt, timestamp), and(eq(messages.createdAt, timestamp), lt(messages.seq, cursor.seq)))!,
        );
      }
      const rows = await db
        .select()
        .from(messages)
        .where(and(...filters))
        .orderBy(desc(messages.createdAt), desc(messages.seq))
        .limit(input.limit + 1);
      const result = page(rows, input.limit, (item) =>
        encodeCursor({ createdAt: item.createdAt.toISOString(), seq: item.seq }),
      );
      result.items.reverse();
      return result;
    },
  };

  return {
    store,
    db,
    async checkConnection() {
      await client`SELECT 1`;
    },
    close: () => client.end(),
  };
}

function page<T>(rows: T[], limit: number, cursor: (item: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? cursor(items[items.length - 1]!) : null };
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor<T>(value: string): T {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    throw invalidInput("Invalid cursor");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
