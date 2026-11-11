import { createScope, defineRepository } from "../../shared/scope.js";
import { modelConfigs, modelProviders, type Database } from "../../../database/index.js";
import { and, asc, eq, isNull, ne, or } from "drizzle-orm";

export type ProviderRow = typeof modelProviders.$inferSelect;
export type ModelRow = typeof modelConfigs.$inferSelect;

export type ProviderInsert = Pick<
  typeof modelProviders.$inferInsert,
  | "protocol"
  | "adapterId"
  | "name"
  | "baseUrl"
  | "credentialCiphertext"
  | "credentialMasked"
  | "enabled"
  | "isPublic"
  | "ownerId"
>;
export type ProviderPatch = Partial<
  Pick<
    ProviderInsert,
    | "protocol"
    | "adapterId"
    | "name"
    | "baseUrl"
    | "credentialCiphertext"
    | "credentialMasked"
    | "enabled"
    | "isPublic"
    | "ownerId"
  >
>;

export type ModelWrite = Pick<
  typeof modelConfigs.$inferInsert,
  | "publicName"
  | "providerId"
  | "upstreamName"
  | "contextWindow"
  | "maxOutput"
  | "thinkingLevels"
  | "parallelToolCalls"
  | "reasoningFormat"
  | "inputModalities"
  | "enabled"
  | "priceIn"
  | "priceOut"
  | "priceCacheRead"
>;

export const modelConfigRepository = defineRepository(({ db, requireTransaction }) => {
  return {
    async listVisibleModels(owner: string) {
      const rows = await db
        .select({ model: modelConfigs, provider: modelProviders })
        .from(modelConfigs)
        .innerJoin(modelProviders, eq(modelConfigs.providerId, modelProviders.id))
        .where(
          and(
            isNull(modelConfigs.deletedAt),
            isNull(modelProviders.deletedAt),
            eq(modelProviders.enabled, true),
            eq(modelConfigs.enabled, true),
            or(eq(modelProviders.isPublic, true), eq(modelProviders.ownerId, owner)),
          ),
        )
        .orderBy(asc(modelProviders.name), asc(modelConfigs.upstreamName))
        .limit(500);
      return rows;
    },
    async createPrivateProfile(provider: ProviderInsert, model: Omit<ModelWrite, "providerId">) {
      const tx = requireTransaction();

      const [savedProvider] = await tx.insert(modelProviders).values(provider).returning();
      if (!savedProvider) throw new Error("Failed to persist private provider");
      const [savedModel] = await tx
        .insert(modelConfigs)
        .values({ ...model, providerId: savedProvider.id })
        .returning();
      if (!savedModel) throw new Error("Failed to persist private model");
      return { model: savedModel, provider: savedProvider };
    },
    async updatePrivateProfile(
      id: string,
      owner: string,
      providerPatch: ProviderPatch,
      modelPatch: Partial<ModelWrite>,
    ) {
      const tx = requireTransaction();

      const [current] = await tx
        .select({ model: modelConfigs, provider: modelProviders })
        .from(modelConfigs)
        .innerJoin(modelProviders, eq(modelConfigs.providerId, modelProviders.id))
        .where(
          and(
            eq(modelConfigs.id, id),
            eq(modelProviders.ownerId, owner),
            eq(modelProviders.isPublic, false),
            isNull(modelConfigs.deletedAt),
            isNull(modelProviders.deletedAt),
          ),
        )
        .limit(1);
      if (!current) return undefined;
      const now = new Date();
      const [provider] = await tx
        .update(modelProviders)
        .set({ ...providerPatch, updatedAt: now })
        .where(eq(modelProviders.id, current.provider.id))
        .returning();
      const [model] = await tx
        .update(modelConfigs)
        .set({ ...modelPatch, updatedAt: now })
        .where(eq(modelConfigs.id, id))
        .returning();
      return model && provider ? { model, provider } : undefined;
    },
    async deletePrivateProfile(id: string, owner: string) {
      const tx = requireTransaction();

      const [row] = await tx
        .select({ providerId: modelConfigs.providerId })
        .from(modelConfigs)
        .innerJoin(modelProviders, eq(modelConfigs.providerId, modelProviders.id))
        .where(
          and(
            eq(modelConfigs.id, id),
            eq(modelProviders.ownerId, owner),
            eq(modelProviders.isPublic, false),
            isNull(modelConfigs.deletedAt),
          ),
        )
        .limit(1);
      if (!row) return false;
      const now = new Date();
      await tx
        .update(modelConfigs)
        .set({ enabled: false, deletedAt: now, updatedAt: now })
        .where(eq(modelConfigs.id, id));
      await tx
        .update(modelProviders)
        .set({ enabled: false, deletedAt: now, updatedAt: now, credentialCiphertext: null })
        .where(eq(modelProviders.id, row.providerId));
      return true;
    },
    async listProviders(): Promise<ProviderRow[]> {
      return db
        .select()
        .from(modelProviders)
        .where(isNull(modelProviders.deletedAt))
        .orderBy(asc(modelProviders.createdAt), asc(modelProviders.id));
    },

    async findProvider(id: string): Promise<ProviderRow | undefined> {
      const [provider] = await db
        .select()
        .from(modelProviders)
        .where(and(eq(modelProviders.id, id), isNull(modelProviders.deletedAt)))
        .limit(1);
      return provider;
    },

    async lockProvider(id: string): Promise<ProviderRow | undefined> {
      requireTransaction();
      const [row] = await db
        .select()
        .from(modelProviders)
        .where(and(eq(modelProviders.id, id), isNull(modelProviders.deletedAt)))
        .for("update");
      return row;
    },
    async hasProviderModels(providerId: string): Promise<boolean> {
      const [model] = await db
        .select({ id: modelConfigs.id })
        .from(modelConfigs)
        .where(and(eq(modelConfigs.providerId, providerId), isNull(modelConfigs.deletedAt)))
        .limit(1);
      return model !== undefined;
    },
    async createProvider(input: ProviderInsert): Promise<ProviderRow> {
      const [provider] = await db.insert(modelProviders).values(input).returning();
      if (!provider) throw new Error("Failed to persist model provider");
      return provider;
    },

    async updateProvider(id: string, patch: ProviderPatch): Promise<ProviderRow | undefined> {
      const tx = requireTransaction();

      const now = new Date();
      const [provider] = await tx
        .update(modelProviders)
        .set({ ...patch, updatedAt: now })
        .where(and(eq(modelProviders.id, id), isNull(modelProviders.deletedAt)))
        .returning();
      if (provider && patch.enabled === false) {
        await tx
          .update(modelConfigs)
          .set({ enabled: false, updatedAt: now })
          .where(and(eq(modelConfigs.providerId, id), isNull(modelConfigs.deletedAt)));
      }
      return provider;
    },

    async deleteProvider(id: string): Promise<boolean> {
      const tx = requireTransaction();

      const now = new Date();
      const deleted = await tx
        .update(modelProviders)
        .set({
          enabled: false,
          credentialCiphertext: null,
          credentialMasked: "••••",
          deletedAt: now,
          updatedAt: now,
        })
        .where(and(eq(modelProviders.id, id), isNull(modelProviders.deletedAt)))
        .returning({ id: modelProviders.id });
      if (deleted.length === 0) return false;
      await tx
        .update(modelConfigs)
        .set({ enabled: false, updatedAt: now })
        .where(and(eq(modelConfigs.providerId, id), isNull(modelConfigs.deletedAt)));
      return true;
    },

    async listModels() {
      const rows = await db
        .select({ model: modelConfigs, providerName: modelProviders.name })
        .from(modelConfigs)
        .innerJoin(modelProviders, eq(modelConfigs.providerId, modelProviders.id))
        .where(isNull(modelConfigs.deletedAt))
        .orderBy(asc(modelConfigs.publicName), asc(modelConfigs.id));
      return rows.map(({ model, providerName }) => ({ ...model, providerName }));
    },

    async findModel(id: string) {
      const [row] = await db
        .select({ model: modelConfigs, providerName: modelProviders.name })
        .from(modelConfigs)
        .innerJoin(modelProviders, eq(modelConfigs.providerId, modelProviders.id))
        .where(and(eq(modelConfigs.id, id), isNull(modelConfigs.deletedAt)))
        .limit(1);
      return row ? { ...row.model, providerName: row.providerName } : undefined;
    },

    async isModelNameTaken(publicName: string, exceptId?: string): Promise<boolean> {
      const rows = await db
        .select({ id: modelConfigs.id })
        .from(modelConfigs)
        .where(and(eq(modelConfigs.publicName, publicName), ...(exceptId ? [ne(modelConfigs.id, exceptId)] : [])))
        .limit(1);
      return rows.length > 0;
    },

    async createModel(input: ModelWrite): Promise<ModelRow> {
      const [model] = await db.insert(modelConfigs).values(input).returning();
      if (!model) throw new Error("Failed to persist model configuration");
      return model;
    },

    async updateModel(id: string, patch: Partial<ModelWrite>): Promise<ModelRow | undefined> {
      const [model] = await db
        .update(modelConfigs)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(modelConfigs.id, id), isNull(modelConfigs.deletedAt)))
        .returning();
      return model;
    },

    async deleteModel(id: string): Promise<boolean> {
      const rows = await db
        .update(modelConfigs)
        .set({ enabled: false, deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(modelConfigs.id, id), isNull(modelConfigs.deletedAt)))
        .returning({ id: modelConfigs.id });
      return rows.length > 0;
    },
  };
});
export function createModelConfigRepository(db: Database) {
  return createScope(db).get(modelConfigRepository);
}

export type ModelConfigRepository = ReturnType<typeof createModelConfigRepository>;
