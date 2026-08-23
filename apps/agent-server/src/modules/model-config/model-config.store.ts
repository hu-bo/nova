import { and, asc, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { randomUUID } from "node:crypto";
import type { ModelConfig } from "@nova/protocol";
import { conflict, notFound } from "../../errors.js";
import { modelApiKeys, modelCatalog, modelProviders, modelQuotas, modelUsage } from "../../db/schema.js";
import type { CredentialCipher } from "./credential.js";

export interface ProviderRow {
  id: string;
  protocol: "openai" | "anthropic";
  name: string;
  baseUrl: string;
  credentialEncrypted: string | null;
  enabled: boolean;
  isPublic: boolean;
  ownerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export type CreateProviderRow = Pick<
  ProviderRow,
  "protocol" | "name" | "baseUrl" | "credentialEncrypted" | "enabled" | "isPublic" | "ownerId"
>;
export type UpdateProviderRow = Partial<CreateProviderRow> & { id: string };

export interface ModelConfigStore {
  listProviders(): Promise<ProviderRow[]>;
  createProvider(input: CreateProviderRow): Promise<ProviderRow>;
  updateProvider(input: UpdateProviderRow): Promise<ProviderRow>;
  deleteProvider(id: string): Promise<void>;
  listModels(userId?: string): Promise<ModelRow[]>;
  listAvailableModels(userId: string): Promise<AvailableModelRow[]>;
  getModel(userId: string, id: string): Promise<{ model: ModelRow; provider: ProviderRow }>;
  createModel(input: CreateModelRow): Promise<ModelRow>;
  updateModel(input: UpdateModelRow): Promise<ModelRow>;
  deleteModel(id: string): Promise<void>;
  listQuotas(): Promise<QuotaRow[]>;
  updateQuota(input: UpdateQuotaRow): Promise<QuotaRow>;
  getUsage(input: GetUsageInput): Promise<UsageReportRow>;
}

export interface AvailableModelRow {
  id: string;
  name: string;
  providerName: string;
  protocol: ProviderRow["protocol"];
  visibility: "public" | "owned";
  contextWindow: number;
  maxOutput: number;
  reasoningFormat: ModelRow["reasoningFormat"];
  thinkingLevels: ModelRow["thinkingLevels"];
  parallelToolCalls: boolean;
  inputModalities: ModelRow["inputModalities"];
}

export interface ModelRow {
  id: string;
  publicName: string;
  providerId: string;
  providerName: string;
  upstreamName: string;
  contextWindow: number;
  maxOutput: number;
  thinkingLevels: Array<"off" | "low" | "medium" | "high" | "max">;
  parallelToolCalls: boolean;
  reasoningFormat: "none" | "openai" | "anthropic" | "deepseek" | "minimax";
  inputModalities: Array<"text" | "image">;
  enabled: boolean;
  priceIn: string;
  priceOut: string;
  priceCacheRead: string;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateModelRow = Omit<ModelRow, "id" | "providerName" | "createdAt" | "updatedAt">;
export type UpdateModelRow = CreateModelRow & { id: string };

export interface QuotaRow {
  apiKeyId: string;
  keyName: string;
  keyPrefix: string;
  rpm: number | null;
  tpm: number | null;
  monthlyCost: string | null;
  updatedAt: Date;
}

export type UpdateQuotaRow = Pick<QuotaRow, "apiKeyId" | "rpm" | "tpm" | "monthlyCost">;

export interface UsageItemRow {
  id: string;
  createdAt: Date;
  apiKeyId: string;
  apiKeyName: string;
  modelId: string;
  modelName: string;
  status: "completed" | "aborted" | "error";
  input: number;
  output: number;
  cacheRead: number;
  cost: string;
  estimated: boolean;
}

export interface UsageReportRow {
  items: UsageItemRow[];
  totals: { requests: number; input: number; output: number; cacheRead: number; cost: string };
  generatedAt: Date;
}

export interface GetUsageInput {
  from?: Date;
  to?: Date;
  apiKeyId?: string;
  modelId?: string;
  status?: UsageItemRow["status"];
  limit: number;
}

export async function resolveCatalogModel(
  store: ModelConfigStore,
  cipher: CredentialCipher,
  userId: string,
  modelId: string,
): Promise<ModelConfig> {
  const { model, provider } = await store.getModel(userId, modelId);
  if (!provider.credentialEncrypted) throw conflict("The selected provider has no credential");
  return {
    provider: provider.protocol,
    endpoint: provider.baseUrl,
    model: model.upstreamName,
    credential: cipher.decrypt(provider.credentialEncrypted),
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    reasoningFormat: model.reasoningFormat,
    thinkingLevels: model.thinkingLevels,
    parallelToolCalls: model.parallelToolCalls,
    inputModalities: model.inputModalities,
  };
}

type Database = ReturnType<typeof drizzle>;

export function createPgModelConfigStore(db: Database): ModelConfigStore {
  return {
    listProviders() {
      return db.select().from(modelProviders).where(isNull(modelProviders.deletedAt)).orderBy(asc(modelProviders.name));
    },
    async createProvider(input) {
      try {
        const [provider] = await db.insert(modelProviders).values(input).returning();
        return provider!;
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("A provider with this name already exists");
        throw error;
      }
    },
    async updateProvider(input) {
      const { id, ...changes } = input;
      try {
        const [provider] = await db
          .update(modelProviders)
          .set({ ...changes, updatedAt: new Date() })
          .where(and(eq(modelProviders.id, id), isNull(modelProviders.deletedAt)))
          .returning();
        if (!provider) throw notFound("Provider");
        return provider;
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("A provider with this name already exists");
        throw error;
      }
    },
    async deleteProvider(id) {
      await db.transaction(async (tx) => {
        const [provider] = await tx
          .update(modelProviders)
          .set({
            enabled: false,
            credentialEncrypted: null,
            deletedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(modelProviders.id, id), isNull(modelProviders.deletedAt)))
          .returning({ id: modelProviders.id });
        if (!provider) throw notFound("Provider");
        await tx
          .update(modelCatalog)
          .set({ enabled: false, updatedAt: new Date() })
          .where(and(eq(modelCatalog.providerId, id), isNull(modelCatalog.deletedAt)));
      });
    },
    async listModels(userId) {
      const rows = await db
        .select({ model: modelCatalog, providerName: modelProviders.name })
        .from(modelCatalog)
        .innerJoin(modelProviders, eq(modelCatalog.providerId, modelProviders.id))
        .where(
          and(
            eq(modelCatalog.enabled, true),
            isNull(modelCatalog.deletedAt),
            eq(modelProviders.enabled, true),
            isNull(modelProviders.deletedAt),
            ...(userId ? [or(eq(modelProviders.isPublic, true), eq(modelProviders.ownerId, userId))!] : []),
          ),
        )
        .orderBy(asc(modelCatalog.publicName));
      return rows.map(({ model, providerName }) => ({ ...model, providerName }));
    },
    async listAvailableModels(userId) {
      const rows = await db
        .select({ model: modelCatalog, provider: modelProviders })
        .from(modelCatalog)
        .innerJoin(modelProviders, eq(modelCatalog.providerId, modelProviders.id))
        .where(
          and(
            eq(modelCatalog.enabled, true),
            isNull(modelCatalog.deletedAt),
            eq(modelProviders.enabled, true),
            isNull(modelProviders.deletedAt),
            or(eq(modelProviders.isPublic, true), eq(modelProviders.ownerId, userId)),
          ),
        )
        .orderBy(asc(modelCatalog.publicName));
      return rows.map(({ model, provider }) => availableModelView(model, provider, userId));
    },
    async getModel(userId, id) {
      const [row] = await db
        .select({ model: modelCatalog, provider: modelProviders })
        .from(modelCatalog)
        .innerJoin(modelProviders, eq(modelCatalog.providerId, modelProviders.id))
        .where(
          and(
            eq(modelCatalog.id, id),
            eq(modelCatalog.enabled, true),
            isNull(modelCatalog.deletedAt),
            eq(modelProviders.enabled, true),
            isNull(modelProviders.deletedAt),
            or(eq(modelProviders.isPublic, true), eq(modelProviders.ownerId, userId)),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Model");
      return { model: modelView(row.model, row.provider.name), provider: row.provider };
    },
    async createModel(input) {
      await requireActiveProvider(db, input.providerId);
      try {
        const [model] = await db.insert(modelCatalog).values(input).returning();
        return modelView(model!, await providerName(db, input.providerId));
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("A model with this public name already exists");
        throw error;
      }
    },
    async updateModel(input) {
      await requireActiveProvider(db, input.providerId);
      const { id, ...changes } = input;
      try {
        const [model] = await db
          .update(modelCatalog)
          .set({ ...changes, updatedAt: new Date() })
          .where(and(eq(modelCatalog.id, id), isNull(modelCatalog.deletedAt)))
          .returning();
        if (!model) throw notFound("Model");
        return modelView(model, await providerName(db, model.providerId));
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("A model with this public name already exists");
        throw error;
      }
    },
    async deleteModel(id) {
      const [model] = await db
        .update(modelCatalog)
        .set({ enabled: false, deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(modelCatalog.id, id), isNull(modelCatalog.deletedAt)))
        .returning({ id: modelCatalog.id });
      if (!model) throw notFound("Model");
    },
    async listQuotas() {
      const rows = await db
        .select({ apiKey: modelApiKeys, quota: modelQuotas })
        .from(modelApiKeys)
        .leftJoin(modelQuotas, eq(modelApiKeys.id, modelQuotas.apiKeyId))
        .orderBy(asc(modelApiKeys.name));
      return rows.map(({ apiKey, quota }) => ({
        apiKeyId: apiKey.id,
        keyName: apiKey.name,
        keyPrefix: apiKey.keyPrefix,
        rpm: quota?.rpm ?? null,
        tpm: quota?.tpm ?? null,
        monthlyCost: quota?.monthlyCost ?? null,
        updatedAt: quota?.updatedAt ?? apiKey.createdAt,
      }));
    },
    async updateQuota(input) {
      const [apiKey] = await db
        .select({
          id: modelApiKeys.id,
          name: modelApiKeys.name,
          keyPrefix: modelApiKeys.keyPrefix,
          createdAt: modelApiKeys.createdAt,
        })
        .from(modelApiKeys)
        .where(eq(modelApiKeys.id, input.apiKeyId))
        .limit(1);
      if (!apiKey) throw notFound("API key");
      const [quota] = await db
        .insert(modelQuotas)
        .values(input)
        .onConflictDoUpdate({
          target: modelQuotas.apiKeyId,
          set: { rpm: input.rpm, tpm: input.tpm, monthlyCost: input.monthlyCost, updatedAt: new Date() },
        })
        .returning();
      return {
        apiKeyId: apiKey.id,
        keyName: apiKey.name,
        keyPrefix: apiKey.keyPrefix,
        rpm: quota!.rpm,
        tpm: quota!.tpm,
        monthlyCost: quota!.monthlyCost,
        updatedAt: quota!.updatedAt,
      };
    },
    async getUsage(input) {
      const filters = [];
      if (input.from) filters.push(gte(modelUsage.createdAt, input.from));
      if (input.to) filters.push(lte(modelUsage.createdAt, input.to));
      if (input.apiKeyId) filters.push(eq(modelUsage.apiKeyId, input.apiKeyId));
      if (input.modelId) filters.push(eq(modelUsage.modelId, input.modelId));
      if (input.status) filters.push(eq(modelUsage.status, input.status));
      const rows = await db
        .select({ usage: modelUsage, apiKeyName: modelApiKeys.name, modelName: modelCatalog.publicName })
        .from(modelUsage)
        .innerJoin(modelApiKeys, eq(modelUsage.apiKeyId, modelApiKeys.id))
        .innerJoin(modelCatalog, eq(modelUsage.modelId, modelCatalog.id))
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(modelUsage.createdAt), desc(modelUsage.id))
        .limit(input.limit);
      return usageReport(rows.map(({ usage, apiKeyName, modelName }) => ({ ...usage, apiKeyName, modelName })));
    },
  };
}

export function createMemoryModelConfigStore(): ModelConfigStore {
  const providers = new Map<string, ProviderRow>();
  const models = new Map<string, ModelRow & { deletedAt: Date | null }>();
  const active = () => [...providers.values()].filter((provider) => !provider.deletedAt);
  const find = (id: string) => {
    const provider = providers.get(id);
    if (!provider || provider.deletedAt) throw notFound("Provider");
    return provider;
  };
  const uniqueName = (name: string, exceptId?: string) => {
    if (active().some((provider) => provider.id !== exceptId && provider.name === name)) {
      throw conflict("A provider with this name already exists");
    }
  };
  return {
    async listProviders() {
      return active().sort((left, right) => left.name.localeCompare(right.name));
    },
    async createProvider(input) {
      uniqueName(input.name);
      const now = new Date();
      const provider = { ...input, id: randomUUID(), createdAt: now, updatedAt: now, deletedAt: null };
      providers.set(provider.id, provider);
      return provider;
    },
    async updateProvider(input) {
      const provider = find(input.id);
      if (input.name) uniqueName(input.name, input.id);
      const updated = { ...provider, ...input, updatedAt: new Date() };
      providers.set(input.id, updated);
      return updated;
    },
    async deleteProvider(id) {
      const provider = find(id);
      providers.set(id, {
        ...provider,
        credentialEncrypted: null,
        enabled: false,
        deletedAt: new Date(),
        updatedAt: new Date(),
      });
      for (const model of models.values())
        if (model.providerId === id && !model.deletedAt)
          models.set(model.id, { ...model, enabled: false, updatedAt: new Date() });
    },
    async listModels(userId) {
      return [...models.values()]
        .filter((model) => {
          const provider = providers.get(model.providerId);
          return (
            model.enabled &&
            !model.deletedAt &&
            provider?.enabled &&
            !provider.deletedAt &&
            (!userId || provider.isPublic || provider.ownerId === userId)
          );
        })
        .sort((left, right) => left.publicName.localeCompare(right.publicName))
        .map(({ deletedAt: _, ...model }) => model);
    },
    async listAvailableModels(userId) {
      return [...models.values()]
        .flatMap((model) => {
          const provider = providers.get(model.providerId);
          if (!model.enabled || model.deletedAt || !provider?.enabled || provider.deletedAt) return [];
          if (!provider.isPublic && provider.ownerId !== userId) return [];
          return [availableModelView(model, provider, userId)];
        })
        .sort((left, right) => left.name.localeCompare(right.name));
    },
    async getModel(userId, id) {
      const model = models.get(id);
      if (!model || model.deletedAt || !model.enabled) throw notFound("Model");
      const provider = find(model.providerId);
      if (!provider.enabled || (!provider.isPublic && provider.ownerId !== userId)) throw notFound("Model");
      return { model: modelView(model, provider.name), provider };
    },
    async createModel(input) {
      const provider = find(input.providerId);
      if (!provider.enabled) throw conflict("The selected provider is disabled");
      if ([...models.values()].some((model) => !model.deletedAt && model.publicName === input.publicName))
        throw conflict("A model with this public name already exists");
      const now = new Date();
      const model = {
        ...input,
        id: randomUUID(),
        providerName: provider.name,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      models.set(model.id, model);
      return modelView(model, provider.name);
    },
    async updateModel(input) {
      const model = models.get(input.id);
      if (!model || model.deletedAt) throw notFound("Model");
      const provider = find(input.providerId);
      if (!provider.enabled) throw conflict("The selected provider is disabled");
      if (
        [...models.values()].some(
          (candidate) => candidate.id !== input.id && !candidate.deletedAt && candidate.publicName === input.publicName,
        )
      )
        throw conflict("A model with this public name already exists");
      const { id, ...changes } = input;
      const updated = { ...model, ...changes, providerName: provider.name, updatedAt: new Date() };
      models.set(id, updated);
      return modelView(updated, provider.name);
    },
    async deleteModel(id) {
      const model = models.get(id);
      if (!model || model.deletedAt) throw notFound("Model");
      models.set(id, { ...model, enabled: false, deletedAt: new Date(), updatedAt: new Date() });
    },
    async listQuotas() {
      return [];
    },
    async updateQuota(input) {
      throw notFound("API key");
    },
    async getUsage() {
      return emptyUsageReport();
    },
  };
}

async function requireActiveProvider(db: Database, id: string): Promise<void> {
  const [provider] = await db
    .select({ enabled: modelProviders.enabled })
    .from(modelProviders)
    .where(and(eq(modelProviders.id, id), isNull(modelProviders.deletedAt)))
    .limit(1);
  if (!provider) throw notFound("Provider");
  if (!provider.enabled) throw conflict("The selected provider is disabled");
}

async function providerName(db: Database, id: string): Promise<string> {
  const [provider] = await db
    .select({ name: modelProviders.name })
    .from(modelProviders)
    .where(eq(modelProviders.id, id))
    .limit(1);
  if (!provider) throw notFound("Provider");
  return provider.name;
}

function modelView(model: Omit<ModelRow, "providerName">, providerName: string): ModelRow {
  return { ...model, providerName };
}

function availableModelView(
  model: Omit<ModelRow, "providerName">,
  provider: ProviderRow,
  userId: string,
): AvailableModelRow {
  return {
    id: model.id,
    name: model.publicName,
    providerName: provider.name,
    protocol: provider.protocol,
    visibility: provider.isPublic ? "public" : provider.ownerId === userId ? "owned" : "public",
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    reasoningFormat: model.reasoningFormat,
    thinkingLevels: model.thinkingLevels,
    parallelToolCalls: model.parallelToolCalls,
    inputModalities: model.inputModalities,
  };
}

function usageReport(items: UsageItemRow[]): UsageReportRow {
  const totals = items.reduce(
    (total, item) => ({
      requests: total.requests + 1,
      input: total.input + item.input,
      output: total.output + item.output,
      cacheRead: total.cacheRead + item.cacheRead,
      cost: total.cost + Number(item.cost),
    }),
    { requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0 },
  );
  return { items, totals: { ...totals, cost: totals.cost.toFixed(8) }, generatedAt: new Date() };
}

function emptyUsageReport(): UsageReportRow {
  return {
    items: [],
    totals: { requests: 0, input: 0, output: 0, cacheRead: 0, cost: "0.00000000" },
    generatedAt: new Date(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
