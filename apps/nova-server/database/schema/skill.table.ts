import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { SkillExecutionRequirements, SkillSource } from "@nova/agent-ui-contracts";

/**
 * 技能管理身份表（docs/design/nova-skills.md §8.1）：
 * - builtin/platform：保存平台草稿（draftBody/draftRequirements），草稿保存携带 draftRevision 防并发覆盖；
 *   currentPublishedVersionId 指向最新已发布版本，仅作列表展示，执行引用固定到确切版本行。
 * - runner-global/runner-project：只保存来源索引（runnerId/workspaceId/relativeCwd/slug + 目录摘要），
 *   磁盘文件保持唯一可编辑源，不复制一份可独立修改的草稿。
 * - 归属由服务端在已认证 Runner session 下校验，不信任客户端/Runner 上报的 ID（红线 2）。
 */
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: text("source").$type<SkillSource>().notNull(),
    /** 内置技能随部署登记，无所有者；用户技能归属单一账号。 */
    ownerUserId: uuid("owner_user_id"),
    /** 平台项目技能的项目归属；本地来源的项目定位走 runner/workspace/cwd 索引列。 */
    projectId: uuid("project_id"),
    /** 本地来源定位：Runner 设备标识（runners.runner_id）、注册工作区 ID 与相对工作区根的 canonicalCwd 目录。 */
    runnerId: text("runner_id"),
    workspaceId: text("workspace_id"),
    relativeCwd: text("relative_cwd"),
    /** frontmatter `name`：小写 kebab-case、≤64，与本地目录/文件名一致；解析派生，不允许另行维护。 */
    slug: text("slug").notNull(),
    /** 展示名（内置与平台可登记元数据）；本地技能为 null，展示回退 slug。 */
    displayName: text("display_name"),
    /** 当前草稿/登记的说明（内置登记与本地目录摘要派生；发布正文以 skill_versions 为准）。 */
    description: text("description").notNull().default(""),
    draftBody: text("draft_body"),
    draftRequirements: jsonb("draft_requirements").$type<SkillExecutionRequirements>(),
    draftRevision: integer("draft_revision").default(1).notNull(),
    /** 指向 skill_versions.id；一致性由服务层保证。 */
    currentPublishedVersionId: uuid("current_published_version_id"),
    /** 停用只拒绝新的选择；已接受排队/恢复与历史保持原版本可用（§6 末段）。 */
    disabled: boolean("disabled").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // 本地来源唯一索引：两个 Runner 的同名全局技能不是同一资源（§4.3 身份与覆盖）。
    uniqueIndex("skills_local_identity_uidx")
      .on(table.ownerUserId, table.runnerId, table.source, table.workspaceId, table.relativeCwd, table.slug)
      .where(sql`source in ('runner-global', 'runner-project') and owner_user_id is not null`),
    // 内置确切 ID 保护：`nova.*` 由部署登记占位，磁盘同名文件不能替换（§4.3）。
    uniqueIndex("skills_builtin_slug_uidx").on(table.slug).where(sql`source = 'builtin'`),
  ],
);

export type SkillRow = typeof skills.$inferSelect;
