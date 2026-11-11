import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ProviderId, ProviderProtocol } from "@nnova/harness/plugins/model-ai-sdk";

export type { ProviderProtocol };

/**
 * Provider credentials are encrypted by the model-config service before persistence.
 * Deleted providers remain as tombstones so model references and audit history survive.
 */
export const modelProviders = pgTable(
  "model_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    protocol: text("protocol").$type<ProviderProtocol>().notNull(),
    // Null preserves per-model adapter selection for providers created before the plugin catalog.
    adapterId: text("adapter_id").$type<ProviderId>(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    credentialCiphertext: text("credential_ciphertext"),
    credentialMasked: text("credential_masked").notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    isPublic: boolean("is_public").default(false).notNull(),
    ownerId: text("owner_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("model_providers_deleted_at_idx").on(table.deletedAt)],
);
