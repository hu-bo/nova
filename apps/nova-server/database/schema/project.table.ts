import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * 项目表:
 * - owner_user_id: 资源归属, 来自 users.id(本地投影); 业务层始终以 owner predicate
 *   限定查询, 不依赖数据库外键约束(见 docs/nova-server.md §6.1.1)。
 * - deleted_at: 软删除标记, 删除流程先置 tombstone 再由附属 job 清理附件引用;
 *   物理删除走单独的 GC job。
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // 历史列表按 owner 过滤; 创建时间 + id 复合排序保证稳定分页
    index("projects_owner_created_idx").on(table.ownerUserId, table.createdAt, table.id),
    // 软删除时间戳, GC job 周期扫描
    index("projects_deleted_at_idx").on(table.deletedAt),
  ],
);