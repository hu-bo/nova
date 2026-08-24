import { randomBytes, randomUUID } from "node:crypto";
import type { Block, ModelConfig, Page } from "@nova/protocol";
import { conflict, notFound } from "./errors.js";

export interface UserProfile {
  casdoorId: string;
  username: string;
  displayName: string;
  role: string;
  isAdmin: boolean;
  isActive: boolean;
}

export interface UserRow extends UserProfile {
  id: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunnerTokenRow {
  id: string;
  userId: string;
  slot: number;
  token: string;
  createdAt: Date;
}

export interface RunnerRow {
  id: string;
  ownerId: string;
  tokenId: string;
  generation: string;
  rootWorkspace: string;
  version: string;
  platform: string;
  capabilities: string[];
  labels: Record<string, string>;
  maxConcurrency: number;
  running: number;
  reportedState: "ready" | "busy" | "draining" | null;
  registeredAt: Date;
  lastSeenAt: Date;
}

export interface ProjectRow {
  id: string;
  userId: string;
  name: string;
  workspace: string | null;
  runnerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationRow {
  id: string;
  userId: string;
  projectId: string | null;
  runnerId: string | null;
  title: string;
  modelConfig: ModelConfig;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  blocks: Block[];
  status: "done" | "error" | "aborted";
  createdAt: Date;
  seq: number;
}

export interface EntryRoute {
  userId: string;
  conversation: ConversationRow;
  project: ProjectRow | null;
}

export interface AgentStore {
  upsertUser(profile: UserProfile): Promise<UserRow>;
  getUser(casdoorId: string): Promise<UserRow | null>;
  ensureRunnerToken(input: { userId: string; token: string }): Promise<RunnerTokenRow>;
  createRunnerToken(input: { userId: string; token: string }): Promise<RunnerTokenRow>;
  listRunnerTokens(userId: string): Promise<RunnerTokenRow[]>;
  findRunnerToken(token: string): Promise<RunnerTokenRow | null>;
  deleteRunnerToken(input: { userId: string; id: string }): Promise<string[]>;
  upsertRunner(input: Omit<RunnerRow, "registeredAt" | "lastSeenAt">): Promise<RunnerRow>;
  updateRunnerStatus(input: {
    ownerId: string;
    id: string;
    running: number;
    reportedState: RunnerRow["reportedState"];
    lastSeenAt: Date;
  }): Promise<void>;
  listRunners(input: { userId: string; limit: number; cursor?: string }): Promise<Page<RunnerRow>>;
  listRunnerIdsByToken(input: { userId: string; tokenId: string }): Promise<string[]>;
  deleteRunner(input: { userId: string; id: string }): Promise<void>;
  createProject(input: { userId: string; name: string }): Promise<ProjectRow>;
  listProjects(userId: string): Promise<ProjectRow[]>;
  updateProject(input: { userId: string; id: string; name: string }): Promise<ProjectRow>;
  bindProject(input: { userId: string; id: string; runnerId: string; workspace: string }): Promise<ProjectRow>;
  deleteProject(input: { userId: string; id: string }): Promise<void>;
  createConversation(input: {
    userId: string;
    projectId: string | null;
    runnerId: string | null;
    title: string;
    modelConfig: ModelConfig;
  }): Promise<ConversationRow>;
  listConversations(input: {
    userId: string;
    projectId?: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<ConversationRow>>;
  routeConversation(userId: string, id: string): Promise<EntryRoute>;
  updateConversationRunner(input: { userId: string; id: string; runnerId: string }): Promise<ConversationRow>;
  setConversationTitleIfUntitled(input: { userId: string; id: string; title: string }): Promise<void>;
  updateConversationModel(input: { userId: string; id: string; modelConfig: ModelConfig }): Promise<ConversationRow>;
  appendMessage(input: Omit<MessageRow, "seq">): Promise<MessageRow>;
  listMessages(input: {
    userId: string;
    conversationId: string;
    before?: string;
    limit: number;
  }): Promise<Page<MessageRow>>;
}

export function createRunnerTokenSecret(): string {
  return `nvr_${randomBytes(32).toString("base64url")}`;
}

type MemoryState = {
  users: Map<string, UserRow>;
  nextUserId: number;
  runnerTokens: Map<string, RunnerTokenRow>;
  runners: Map<string, RunnerRow>;
  projects: Map<string, ProjectRow>;
  conversations: Map<string, ConversationRow>;
  messages: MessageRow[];
  nextMessageSeq: number;
};

export function createMemoryStore(): AgentStore {
  const state: MemoryState = {
    users: new Map(),
    nextUserId: 1,
    runnerTokens: new Map(),
    runners: new Map(),
    projects: new Map(),
    conversations: new Map(),
    messages: [],
    nextMessageSeq: 1,
  };

  const ownedProject = (userId: string, id: string): ProjectRow => {
    const project = state.projects.get(id);
    if (!project || project.userId !== userId) throw notFound("Project");
    return project;
  };

  const ownedConversation = (userId: string, id: string): ConversationRow => {
    const conversation = state.conversations.get(id);
    if (!conversation || conversation.userId !== userId) throw notFound("Conversation");
    return conversation;
  };

  return {
    async upsertUser(profile) {
      const existing = state.users.get(profile.casdoorId);
      const user: UserRow = existing
        ? { ...existing, ...profile, updatedAt: new Date() }
        : { ...profile, id: state.nextUserId++, createdAt: new Date(), updatedAt: new Date() };
      state.users.set(profile.casdoorId, user);
      return user;
    },
    async getUser(casdoorId) {
      return state.users.get(casdoorId) ?? null;
    },
    async ensureRunnerToken(input) {
      const existing = [...state.runnerTokens.values()].find((item) => item.userId === input.userId);
      if (existing) return existing;
      const token = { id: randomUUID(), userId: input.userId, slot: 1, token: input.token, createdAt: new Date() };
      state.runnerTokens.set(token.id, token);
      return token;
    },
    async createRunnerToken(input) {
      const used = new Set(
        [...state.runnerTokens.values()].filter((item) => item.userId === input.userId).map((item) => item.slot),
      );
      const slot = [1, 2, 3].find((value) => !used.has(value));
      if (!slot) throw conflict("Each user can create up to 3 runner tokens");
      const token = { id: randomUUID(), userId: input.userId, slot, token: input.token, createdAt: new Date() };
      state.runnerTokens.set(token.id, token);
      return token;
    },
    async listRunnerTokens(userId) {
      return [...state.runnerTokens.values()]
        .filter((item) => item.userId === userId)
        .sort((left, right) => left.slot - right.slot);
    },
    async findRunnerToken(token) {
      return [...state.runnerTokens.values()].find((item) => item.token === token) ?? null;
    },
    async deleteRunnerToken(input) {
      const token = state.runnerTokens.get(input.id);
      if (!token || token.userId !== input.userId) throw notFound("Runner token");
      const bound = [...state.runners.values()]
        .filter((item) => item.ownerId === input.userId && item.tokenId === input.id)
        .map((item) => item.id);
      if (!bound.length) state.runnerTokens.delete(input.id);
      return bound;
    },
    async upsertRunner(input) {
      const key = runnerKey(input.ownerId, input.id);
      const existing = state.runners.get(key);
      const now = new Date();
      const runner = { ...input, registeredAt: existing?.registeredAt ?? now, lastSeenAt: now };
      state.runners.set(key, runner);
      return runner;
    },
    async updateRunnerStatus(input) {
      const key = runnerKey(input.ownerId, input.id);
      const runner = state.runners.get(key);
      if (runner)
        state.runners.set(key, {
          ...runner,
          running: input.running,
          reportedState: input.reportedState,
          lastSeenAt: input.lastSeenAt,
        });
    },
    async listRunners(input) {
      const offset = decodeOffset(input.cursor);
      const all = [...state.runners.values()]
        .filter((item) => item.ownerId === input.userId)
        .sort(
          (left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime() || right.id.localeCompare(left.id),
        );
      const items = all.slice(offset, offset + input.limit);
      return { items, nextCursor: offset + items.length < all.length ? encodeOffset(offset + items.length) : null };
    },
    async listRunnerIdsByToken(input) {
      return [...state.runners.values()]
        .filter((item) => item.ownerId === input.userId && item.tokenId === input.tokenId)
        .map((item) => item.id)
        .sort();
    },
    async deleteRunner(input) {
      if (!state.runners.delete(runnerKey(input.userId, input.id))) throw notFound("Runner");
    },
    async createProject(input) {
      const now = new Date();
      const project: ProjectRow = {
        id: randomUUID(),
        userId: input.userId,
        name: input.name,
        workspace: null,
        runnerId: null,
        createdAt: now,
        updatedAt: now,
      };
      state.projects.set(project.id, project);
      return project;
    },
    async listProjects(userId) {
      return [...state.projects.values()]
        .filter((project) => project.userId === userId)
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    },
    async updateProject(input) {
      const project = ownedProject(input.userId, input.id);
      const updated = { ...project, name: input.name, updatedAt: new Date() };
      state.projects.set(project.id, updated);
      return updated;
    },
    async bindProject(input) {
      const duplicate = [...state.projects.values()].some(
        (project) =>
          project.userId === input.userId &&
          project.id !== input.id &&
          project.runnerId === input.runnerId &&
          project.workspace === input.workspace,
      );
      if (duplicate) throw conflict("A project already uses this runner workspace");
      const project = ownedProject(input.userId, input.id);
      const updated = { ...project, runnerId: input.runnerId, workspace: input.workspace, updatedAt: new Date() };
      state.projects.set(project.id, updated);
      return updated;
    },
    async deleteProject(input) {
      ownedProject(input.userId, input.id);
      state.projects.delete(input.id);
      const conversationIds = new Set(
        [...state.conversations.values()].filter((item) => item.projectId === input.id).map((item) => item.id),
      );
      for (const id of conversationIds) state.conversations.delete(id);
      state.messages = state.messages.filter((message) => !conversationIds.has(message.conversationId));
    },
    async createConversation(input) {
      if (input.projectId) ownedProject(input.userId, input.projectId);
      const now = new Date();
      const conversation: ConversationRow = {
        id: randomUUID(),
        userId: input.userId,
        projectId: input.projectId,
        runnerId: input.runnerId,
        title: input.title,
        modelConfig: input.modelConfig,
        createdAt: now,
        updatedAt: now,
      };
      state.conversations.set(conversation.id, conversation);
      return conversation;
    },
    async listConversations(input) {
      const offset = decodeOffset(input.cursor);
      const all = [...state.conversations.values()]
        .filter(
          (item) =>
            item.userId === input.userId && (input.projectId === undefined || item.projectId === input.projectId),
        )
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || right.id.localeCompare(left.id));
      const items = all.slice(offset, offset + input.limit);
      return { items, nextCursor: offset + items.length < all.length ? encodeOffset(offset + items.length) : null };
    },
    async routeConversation(userId, id) {
      const conversation = ownedConversation(userId, id);
      const project = conversation.projectId ? ownedProject(userId, conversation.projectId) : null;
      return { userId, conversation, project };
    },
    async updateConversationRunner(input) {
      const conversation = ownedConversation(input.userId, input.id);
      const updated = { ...conversation, runnerId: input.runnerId, updatedAt: new Date() };
      state.conversations.set(conversation.id, updated);
      return updated;
    },
    async setConversationTitleIfUntitled(input) {
      const conversation = ownedConversation(input.userId, input.id);
      if (conversation.title === "New conversation") {
        state.conversations.set(conversation.id, { ...conversation, title: input.title, updatedAt: new Date() });
      }
    },
    async updateConversationModel(input) {
      const conversation = ownedConversation(input.userId, input.id);
      const updated = { ...conversation, modelConfig: input.modelConfig, updatedAt: new Date() };
      state.conversations.set(conversation.id, updated);
      return updated;
    },
    async appendMessage(input) {
      const message = { ...input, seq: state.nextMessageSeq++ };
      state.messages.push(message);
      const conversation = state.conversations.get(input.conversationId);
      if (conversation) state.conversations.set(conversation.id, { ...conversation, updatedAt: input.createdAt });
      return message;
    },
    async listMessages(input) {
      ownedConversation(input.userId, input.conversationId);
      const before = input.before ? decodeOffset(input.before) : Number.POSITIVE_INFINITY;
      const all = state.messages
        .filter((message) => message.conversationId === input.conversationId && message.seq < before)
        .sort((left, right) => right.seq - left.seq);
      const items = all.slice(0, input.limit).reverse();
      return { items, nextCursor: all.length > input.limit ? encodeOffset(all[input.limit - 1]!.seq) : null };
    },
  };
}

function runnerKey(userId: string, runnerId: string): string {
  return `${userId}\0${runnerId}`;
}

function encodeOffset(value: number): string {
  return Buffer.from(String(value)).toString("base64url");
}

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(value) || value < 0) throw notFound("Cursor");
  return value;
}
