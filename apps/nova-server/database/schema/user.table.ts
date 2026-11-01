import { boolean, uniqueIndex, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * 本地用户表: identity_id 是 Auth Service 下发的稳定身份标识; 唯一。
 * 同一身份多次登录复用同一行; active=false 不开放服务但保留行(用于审计)。
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    identityId: text("identity_id").notNull(),
    active: boolean("active").default(true).notNull(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("users_identity_id_idx").on(table.identityId)],
);
