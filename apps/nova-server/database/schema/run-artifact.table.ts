import { bigint, index, jsonb, pgTable, text as pgTableText, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { productId } from "./product-id.js";
import type { ArtifactPreviewKind, ArtifactState, PublicError } from "@nova/agent-ui-contracts";
import { skillVersions } from "./skill-version.table.js";
import { runs } from "./run.table.js";

/**
 * 文件产物索引表（docs/design/nova-skills.md §7、§8.1，P1-B1）。
 * - 归属由 Run→会话链派生（run_id 外键），不另建可漂移的权限关系表；
 *   这里不冗余 owner/conversation，读接口经 join 校验当前用户/项目。
 * - state 只描述文件发布，执行结果仍读 runs.state（不维护第二套状态机）。
 * - 稳定发布键 (run_id, tool_execution_id) 唯一：相同工具执行重放返回原记录，不新建产物。
 * - object_key 由服务端按 §5.2 前缀构造；显示文件名只存本表，不参与拼键。
 * - 版本引用可空 skill_version_id：归属本次用户技能；仅内置/普通会话留空（§8.1 末段）。
 */
export const runArtifacts = pgTable(
  "run_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** 归属由 Run→会话链派生；删除 Run 级联清索引（§7 清理段）。 */
    runId: productId("run_id", "run")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    toolExecutionId: pgTableText("tool_execution_id").notNull(),
    skillVersionId: uuid("skill_version_id").references(() => skillVersions.id, { onDelete: "set null" }),
    name: pgTableText("name").notNull(),
    mimeType: pgTableText("mime_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    sha256: pgTableText("sha256"),
    objectKey: pgTableText("object_key"),
    state: pgTableText("state").$type<ArtifactState>().notNull().default("publishing"),
    /** 预览策略：服务端在发布时按类型矩阵派生，读接口直接返回（单来源，客户端不重算）。 */
    preview: pgTableText("preview").$type<ArtifactPreviewKind>().notNull().default("download"),
    /** 恢复元数据：上传确认状态、待核实标记、源文件指纹等（§7 崩溃窗口）。 */
    recovery: jsonb("recovery").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<PublicError>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("run_artifacts_run_execution_uidx").on(table.runId, table.toolExecutionId),
    index("run_artifacts_state_idx").on(table.state, table.updatedAt),
  ],
);

export type RunArtifactRow = typeof runArtifacts.$inferSelect;
