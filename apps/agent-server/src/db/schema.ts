import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { Block, ModelConfig } from "@nova/protocol";
import type { Entry, Record as AgentRecord } from "@nova/agent-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  casdoorId: varchar("casdoor_id", { length: 128 }).notNull().unique("users_casdoor_id_unique"),
  username: varchar("username", { length: 64 }).notNull().default(""),
  displayName: varchar("display_name", { length: 64 }).notNull().default(""),
  role: varchar("role", { length: 64 }).notNull().default(""),
  isAdmin: boolean("is_admin").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const modelProviders = pgTable(
  "model_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    protocol: text("protocol").$type<"openai" | "anthropic">().notNull(),
    name: varchar("name", { length: 80 }).notNull().unique("model_providers_name_unique"),
    baseUrl: text("base_url").notNull(),
    credentialEncrypted: text("credential_encrypted"),
    enabled: boolean("enabled").notNull().default(true),
    isPublic: boolean("is_public").notNull().default(false),
    ownerId: varchar("owner_id", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({ columns: [table.ownerId], foreignColumns: [users.casdoorId], name: "model_providers_owner_fk" }),
    index("model_providers_visibility_idx").on(table.isPublic, table.ownerId),
  ],
);

export const modelCatalog = pgTable(
  "model_catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicName: varchar("public_name", { length: 100 }).notNull().unique("model_catalog_public_name_unique"),
    providerId: uuid("provider_id").notNull(),
    upstreamName: varchar("upstream_name", { length: 150 }).notNull(),
    contextWindow: integer("context_window").notNull(),
    maxOutput: integer("max_output").notNull(),
    thinkingLevels: text("thinking_levels").array().$type<Array<"off" | "low" | "medium" | "high" | "max">>().notNull(),
    parallelToolCalls: boolean("parallel_tool_calls").notNull(),
    reasoningFormat: text("reasoning_format")
      .$type<"none" | "openai" | "anthropic" | "deepseek" | "minimax">()
      .notNull(),
    inputModalities: text("input_modalities").array().$type<Array<"text" | "image">>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    priceIn: numeric("price_in", { precision: 18, scale: 8 }).notNull(),
    priceOut: numeric("price_out", { precision: 18, scale: 8 }).notNull(),
    priceCacheRead: numeric("price_cache_read", { precision: 18, scale: 8 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({ columns: [table.providerId], foreignColumns: [modelProviders.id], name: "model_catalog_provider_fk" }),
  ],
);

export const modelApiKeys = pgTable("model_api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  keyPrefix: varchar("key_prefix", { length: 32 }).notNull(),
  name: varchar("name", { length: 80 }).notNull(),
  ownerId: varchar("owner_id", { length: 120 }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const modelQuotas = pgTable(
  "model_quotas",
  {
    apiKeyId: uuid("api_key_id").primaryKey(),
    rpm: integer("rpm"),
    tpm: integer("tpm"),
    monthlyCost: numeric("monthly_cost", { precision: 18, scale: 8 }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.apiKeyId],
      foreignColumns: [modelApiKeys.id],
      name: "model_quotas_api_key_fk",
    }).onDelete("cascade"),
  ],
);

export const modelUsage = pgTable(
  "model_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    apiKeyId: uuid("api_key_id").notNull(),
    modelId: uuid("model_id").notNull(),
    status: text("status").$type<"completed" | "aborted" | "error">().notNull(),
    input: bigint("input", { mode: "number" }).notNull(),
    output: bigint("output", { mode: "number" }).notNull(),
    cacheRead: bigint("cache_read", { mode: "number" }).notNull().default(0),
    cost: numeric("cost", { precision: 20, scale: 8 }).notNull(),
    estimated: boolean("estimated").notNull().default(false),
  },
  (table) => [
    foreignKey({ columns: [table.apiKeyId], foreignColumns: [modelApiKeys.id], name: "model_usage_api_key_fk" }),
    foreignKey({ columns: [table.modelId], foreignColumns: [modelCatalog.id], name: "model_usage_model_fk" }),
    index("model_usage_api_key_created_idx").on(table.apiKeyId, table.createdAt),
    index("model_usage_model_created_idx").on(table.modelId, table.createdAt),
  ],
);

export const runnerTokens = pgTable(
  "runner_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: varchar("user_id", { length: 128 }).notNull(),
    slot: integer("slot").notNull(),
    token: varchar("token", { length: 128 }).notNull().unique("runner_tokens_token_unique"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.userId], foreignColumns: [users.casdoorId], name: "runner_tokens_user_fk" }).onDelete(
      "cascade",
    ),
    unique("runner_tokens_user_slot_unique").on(table.userId, table.slot),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: varchar("user_id", { length: 128 }).notNull(),
    name: text("name").notNull(),
    workspace: text("workspace"),
    runnerId: text("runner_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.userId], foreignColumns: [users.casdoorId], name: "projects_user_fk" }),
    unique("projects_owner_workspace_unique").on(table.userId, table.runnerId, table.workspace),
    unique("projects_id_user_unique").on(table.id, table.userId),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: varchar("user_id", { length: 128 }).notNull(),
    projectId: uuid("project_id"),
    runnerId: text("runner_id"),
    title: text("title").notNull(),
    modelConfig: jsonb("model_config").$type<ModelConfig>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.userId], foreignColumns: [users.casdoorId], name: "conversations_user_fk" }),
    foreignKey({
      columns: [table.projectId, table.userId],
      foreignColumns: [projects.id, projects.userId],
      name: "conversations_project_owner_fk",
    }).onDelete("cascade"),
    index("conversations_owner_project_updated_idx").on(table.userId, table.projectId, table.updatedAt, table.id),
  ],
);

export const entries = pgTable(
  "entries",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    parentId: text("parent_id"),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Entry>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.id] }),
    foreignKey({
      columns: [table.conversationId, table.parentId],
      foreignColumns: [table.conversationId, table.id],
      name: "entries_parent_fk",
    }),
    index("entries_conversation_seq_idx").on(table.conversationId, table.seq),
  ],
);

export const records = pgTable(
  "records",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    runId: text("run_id").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<AgentRecord>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.id] }),
    index("records_conversation_run_seq_idx").on(table.conversationId, table.runId, table.seq),
    index("records_conversation_kind_seq_idx").on(table.conversationId, table.kind, table.seq),
  ],
);

export const messages = pgTable(
  "messages",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    blocks: jsonb("blocks").$type<Block[]>().notNull(),
    status: text("status").$type<"done" | "error" | "aborted">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.id] }),
    index("messages_conversation_created_seq_idx").on(table.conversationId, table.createdAt, table.seq),
  ],
);

export const runners = pgTable(
  "runners",
  {
    id: text("id").notNull(),
    ownerId: varchar("owner_id", { length: 128 }).notNull(),
    tokenId: uuid("token_id").notNull(),
    generation: text("generation").notNull(),
    rootWorkspace: text("root_workspace").notNull(),
    version: text("version").notNull(),
    platform: text("platform").notNull(),
    capabilities: text("capabilities").array().notNull(),
    labels: jsonb("labels").$type<Record<string, string>>().notNull(),
    maxConcurrency: integer("max_concurrency").notNull(),
    running: integer("running").notNull(),
    reportedState: text("reported_state").$type<"ready" | "busy" | "draining">(),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.id] }),
    foreignKey({ columns: [table.ownerId], foreignColumns: [users.casdoorId], name: "runners_owner_fk" }),
    foreignKey({ columns: [table.tokenId], foreignColumns: [runnerTokens.id], name: "runners_token_fk" }),
    index("runners_owner_seen_idx").on(table.ownerId, table.lastSeenAt, table.id),
  ],
);
