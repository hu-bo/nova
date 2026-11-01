import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const remoteConnections = pgTable(
  "remote_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id").notNull(),
    name: text("name").notNull(),
    hostname: text("hostname").notNull(),
    port: integer("port").default(22).notNull(),
    username: text("username").notNull(),
    rootPath: text("root_path").notNull(),
    authMethod: text("auth_method").$type<"private_key" | "password">().notNull(),
    credentialCiphertext: text("credential_ciphertext").notNull(),
    passphraseCiphertext: text("passphrase_ciphertext"),
    hostFingerprint: text("host_fingerprint"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [index("remote_connections_owner_idx").on(table.ownerUserId)],
);
