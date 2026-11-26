import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * 项目环境绑定表:
 * - 一份 binding = 一个完整可执行环境快照(runner + workspace + 规范化 cwd + 指令配置)。
 * - 不允许跨字段拆开更新; 每次绑定变更都生成新 revision, 由 (project_id, revision) 唯一约束保证。
 * - is_current=true 的部分唯一索引保证"每项目仅一个当前 binding"。
 * - 旧会话仍持有原 binding revision, 不随当前 binding 变更自动跟进; 绑定的设备离线时
 *   可从会话入口直接切换 Runner (PUT /api/conversations/:id/binding, 在线设备不允许切走,
 *   见 docs/design/nova-client.md)。
 */
export type InstructionConfig = {
  readonly source?: "agents" | "claude" | "custom" | "none";
  readonly baselineFiles?: readonly { readonly path: string; readonly sha256: string }[];
  readonly customPrompt?: string;
};

export const projectBindings = pgTable(
  "project_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    revision: integer("revision").notNull(),
    runnerId: uuid("runner_id"),
    remoteConnectionId: uuid("remote_connection_id"),
    workspaceId: text("workspace_id").notNull(),
    canonicalCwd: text("canonical_cwd").notNull(),
    instructions: jsonb("instructions").$type<InstructionConfig>().notNull(),
    isCurrent: boolean("is_current").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  },
  (table) => [
    index("project_bindings_project_revision_idx").on(table.projectId, table.revision),
    index("project_bindings_project_current_idx").on(table.projectId),
  ],
);
