import { pgTable, index, text, timestamp, jsonb, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { SkillExecutionRequirements, SkillResourceEntry } from "@nova/agent-ui-contracts";
import { skills } from "./skill.table.js";

/**
 * 不可变技能执行版本表（docs/nova-skills.md §6、§8.1）。
 * - 发布后不覆盖正文与执行配置；同 (skillId, version) 不同摘要的写入被服务层拒绝（409），
 *   不提供物理删除入口，已引用版本保留。
 * - sha256 覆盖「规范化正文 + 执行配置 + 资源清单」，版本摘要即快照身份。
 * - 本地来源无语义版本号的由服务端映射到 0.0.<revision>，同摘要复用版本行（§4.3）。
 * - resources 仅记录路径/大小/摘要清单，P0 不接对象引用（P2 资源包再接）。
 */
export const skillVersions = pgTable(
  "skill_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    /** 发布正文（SKILL.md 全文，含 frontmatter；解析元数据从它派生）。 */
    body: text("body").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull(),
    displayName: text("display_name"),
    requirements: jsonb("requirements").$type<SkillExecutionRequirements>().notNull(),
    sha256: text("sha256").notNull(),
    /** 本地来源快照的磁盘入口文件原始摘要（Runner 目录摘要）；平台/内置为 null。快照漂移按它判定（§4.3）。 */
    sourceSha256: text("source_sha256"),
    resources: jsonb("resources").$type<SkillResourceEntry[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("skill_versions_skill_version_uidx").on(table.skillId, table.version),
    index("skill_versions_skill_sha_idx").on(table.skillId, table.sha256),
  ],
);

export type SkillVersionRow = typeof skillVersions.$inferSelect;
