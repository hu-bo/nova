import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Principal } from "../src/modules/identity/index.js";
import type {
  ModelConfigRepository,
  ModelRow,
  ProviderRow,
} from "../src/modules/model-config/model-config.repository.js";
import { ModelConfigService } from "../src/modules/model-config/model-config.service.js";
import {
  createModelBodySchema,
  createProviderBodySchema,
  updateProviderBodySchema,
} from "../src/modules/model-config/model-config.schema.js";
import { createCredentialCipher } from "../src/shared/credential-cipher.js";
import {
  createUserModelProfileSchema,
  UserModelProfilesService,
} from "../src/modules/model-config/user-model-profiles.js";
import type { ServiceTransaction } from "../src/shared/scope.js";

const encryptionKey = "ab".repeat(32);
const principal: Principal = { identityId: "test-owner", localUserId: randomUUID(), roles: ["admin"] };
const customBaseURL = "https://gateway.example/tenant/models/v1";
const credential = "test-provider-secret";
const createdAt = new Date("2026-11-12T00:00:00Z");

test("invalid provider and profile URLs produce validation issues instead of escaping as exceptions", () => {
  for (const endpoint of ["not a URL", "/relative/v1", "https://user:password@gateway.example/v1"]) {
    assert.equal(
      createProviderBodySchema.safeParse({
        adapterId: "deepseek",
        name: "Gateway",
        baseUrl: endpoint,
        credential,
      }).success,
      false,
    );
    assert.equal(updateProviderBodySchema.safeParse({ baseUrl: endpoint }).success, false);
    assert.equal(
      createUserModelProfileSchema.safeParse({
        providerName: "Gateway",
        provider: "openai",
        endpoint,
        model: "fixture",
        contextWindow: 32000,
        maxOutput: 8192,
        thinkingLevels: [],
        reasoningFormat: "none",
        parallelToolCalls: true,
        supportsImages: false,
        credential,
      }).success,
      false,
    );
  }
});

function providerRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: randomUUID(),
    adapterId: "deepseek",
    protocol: "openai",
    name: "Private gateway",
    baseUrl: customBaseURL,
    credentialCiphertext: null,
    credentialMasked: "masked",
    enabled: true,
    isPublic: false,
    ownerId: principal.localUserId,
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function modelRow(providerId: string, overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    id: randomUUID(),
    providerId,
    publicName: "existing-model",
    upstreamName: "upstream-model",
    contextWindow: "32000",
    maxOutput: "8192",
    thinkingLevels: ["low"],
    parallelToolCalls: true,
    reasoningFormat: "deepseek",
    inputModalities: ["text"],
    enabled: true,
    priceIn: "0",
    priceOut: "0",
    priceCacheRead: "0",
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function fixture(initialProviders: ProviderRow[] = [], initialModels: ModelRow[] = []) {
  const providers = new Map(initialProviders.map((provider) => [provider.id, structuredClone(provider)]));
  const models = new Map(initialModels.map((model) => [model.id, structuredClone(model)]));
  const writes = { providers: 0, models: 0 };
  const unexpected = (): never => {
    throw new Error("Unexpected repository operation in model-config test");
  };
  const findModel = (id: string) => {
    const model = models.get(id);
    const provider = model && providers.get(model.providerId);
    return model && provider ? { ...model, providerName: provider.name } : undefined;
  };
  const repository: ModelConfigRepository = {
    tx: () => repository,
    async listVisibleModels(owner) {
      return [...models.values()].flatMap((model) => {
        const provider = providers.get(model.providerId);
        if (!provider?.enabled || !model.enabled || (!provider.isPublic && provider.ownerId !== owner)) return [];
        return [{ model, provider }];
      });
    },
    createPrivateProfile: unexpected,
    updatePrivateProfile: unexpected,
    deletePrivateProfile: unexpected,
    async listProviders() {
      return [...providers.values()];
    },
    async findProvider(id) {
      return providers.get(id);
    },
    async lockProvider(id) {
      return providers.get(id);
    },
    async hasProviderModels(id) {
      return [...models.values()].some((model) => model.providerId === id);
    },
    async createProvider(input) {
      const saved = providerRow({
        ...input,
        adapterId: input.adapterId ?? null,
        credentialCiphertext: input.credentialCiphertext ?? null,
        enabled: input.enabled ?? false,
        isPublic: input.isPublic ?? false,
        ownerId: input.ownerId ?? null,
      });
      writes.providers++;
      providers.set(saved.id, saved);
      return saved;
    },
    async updateProvider(id, patch) {
      const current = providers.get(id);
      if (!current) return undefined;
      const saved = providerRow({
        ...current,
        ...patch,
        adapterId: patch.adapterId === undefined ? current.adapterId : patch.adapterId,
        credentialCiphertext:
          patch.credentialCiphertext === undefined ? current.credentialCiphertext : patch.credentialCiphertext,
        enabled: patch.enabled ?? current.enabled,
        isPublic: patch.isPublic ?? current.isPublic,
        ownerId: patch.ownerId === undefined ? current.ownerId : patch.ownerId,
      });
      writes.providers++;
      providers.set(id, saved);
      return saved;
    },
    deleteProvider: unexpected,
    async listModels() {
      return [...models.keys()].flatMap((id) => {
        const model = findModel(id);
        return model ? [model] : [];
      });
    },
    async findModel(id) {
      return findModel(id);
    },
    async isModelNameTaken(name, exceptId) {
      return [...models.values()].some((model) => model.id !== exceptId && model.publicName === name);
    },
    async createModel(input) {
      const saved = modelRow(input.providerId, {
        ...input,
        thinkingLevels: input.thinkingLevels ?? [],
        parallelToolCalls: input.parallelToolCalls ?? true,
        reasoningFormat: input.reasoningFormat ?? "none",
        inputModalities: input.inputModalities ?? ["text"],
        enabled: input.enabled ?? false,
        priceIn: input.priceIn ?? "0",
        priceOut: input.priceOut ?? "0",
        priceCacheRead: input.priceCacheRead ?? "0",
      });
      writes.models++;
      models.set(saved.id, saved);
      return saved;
    },
    updateModel: unexpected,
    deleteModel: unexpected,
  };
  const transaction: ServiceTransaction<{ repository: ModelConfigRepository }> = async (operation) =>
    operation({ repository });
  return {
    service: new ModelConfigService(repository, encryptionKey, transaction),
    profiles: new UserModelProfilesService(repository, encryptionKey, transaction),
    providers,
    models,
    writes,
  };
}

test("available model capabilities exclude unsupported legacy reasoning settings", async () => {
  const provider = providerRow({ adapterId: null });
  const model = modelRow(provider.id, { reasoningFormat: "minimax", thinkingLevels: ["off", "low"] });
  const { profiles } = fixture([provider], [model]);
  const [available] = await profiles.list(principal.localUserId);
  assert.deepEqual(available?.thinkingLevels, ["low"]);
  await assert.rejects(profiles.validateSelection(model.id, principal.localUserId, "off"), {
    code: "INFERENCE_STRENGTH_UNAVAILABLE",
  });
  await profiles.validateSelection(model.id, principal.localUserId, "low");
});

function modelInput(providerId: string, extra: Record<string, unknown> = {}) {
  return createModelBodySchema.parse({
    publicName: "new-model",
    providerId,
    upstreamName: "configured-upstream",
    contextWindow: 32000,
    maxOutput: 8192,
    thinkingLevels: ["low"],
    ...extra,
  });
}

test("provider creation derives protocol from the adapter and preserves a custom gateway URL", async () => {
  const input = createProviderBodySchema.parse({
    adapterId: "anthropic",
    name: "Gateway",
    baseUrl: customBaseURL,
    credential,
  });
  assert.equal(input.protocol, undefined);
  const state = fixture();
  const saved = await state.service.createProvider(input, principal);
  assert.equal(saved.adapterId, "anthropic");
  assert.equal(saved.protocol, "anthropic");
  assert.equal(saved.baseUrl, customBaseURL);
  assert.equal(saved.ownerId, principal.localUserId);
  const stored = state.providers.get(saved.id);
  assert.ok(stored?.credentialCiphertext);
  assert.equal(createCredentialCipher(encryptionKey).decrypt(stored.credentialCiphertext), credential);
  assert.equal("credentialCiphertext" in saved, false);
});

test("legacy protocol-only creation remains valid without choosing an adapter", async () => {
  const state = fixture();
  const input = createProviderBodySchema.parse({
    protocol: "openai",
    name: "Legacy gateway",
    baseUrl: customBaseURL,
    credential,
  });
  const saved = await state.service.createProvider(input, principal);
  assert.equal(saved.adapterId, null);
  assert.equal(saved.protocol, "openai");
  assert.equal(saved.baseUrl, customBaseURL);
});

test("provider input rejects a missing adapter/protocol and mismatched explicit protocols", () => {
  const base = { name: "Gateway", baseUrl: customBaseURL, credential };
  assert.equal(createProviderBodySchema.safeParse(base).success, false);
  assert.equal(
    createProviderBodySchema.safeParse({ ...base, adapterId: "anthropic", protocol: "openai" }).success,
    false,
  );
  assert.equal(
    createProviderBodySchema.safeParse({ ...base, adapterId: "deepseek", protocol: "anthropic" }).success,
    false,
  );
  assert.equal(
    createProviderBodySchema.safeParse({ ...base, adapterId: "deepseek", protocol: "openai" }).success,
    true,
  );
});

test("model persistence derives reasoning from the provider instead of the submitted legacy format", async () => {
  for (const adapterId of ["openai", "anthropic", "deepseek", "minimax", "minimax-anthropic"] as const) {
    const protocol = adapterId === "anthropic" || adapterId === "minimax-anthropic" ? "anthropic" : "openai";
    const provider = providerRow({ adapterId, protocol });
    const state = fixture([provider]);
    const saved = await state.service.createModel(modelInput(provider.id, { reasoningFormat: "openai" }));
    const expectedFormat = adapterId === "minimax-anthropic" ? "minimax" : adapterId;
    assert.equal(saved.reasoningFormat, expectedFormat, adapterId);
    assert.deepEqual(saved.thinkingLevels, ["low"]);
    assert.equal(state.models.get(saved.id)?.contextWindow, "32000");
  }
});

test("a model without thinking remains non-reasoning even when its provider supports it", async () => {
  const provider = providerRow();
  const state = fixture([provider]);
  const saved = await state.service.createModel(modelInput(provider.id, { thinkingLevels: [] }));
  assert.equal(saved.reasoningFormat, "none");
  assert.deepEqual(saved.thinkingLevels, []);
});

test("unsupported thinking settings fail before persistence", async () => {
  for (const [adapterId, thinkingLevels] of [
    ["openai-compatible", ["low"]],
    ["minimax", ["off"]],
  ] as const) {
    const provider = providerRow({ adapterId });
    const state = fixture([provider]);
    await assert.rejects(state.service.createModel(modelInput(provider.id, { thinkingLevels })), {
      code: "VALIDATION_ERROR",
    });
    assert.equal(state.writes.models, 0);
    assert.equal(state.models.size, 0);
  }
});

test("legacy providers retain explicit per-model reasoning formats", async () => {
  const provider = providerRow({ adapterId: null });
  const state = fixture([provider]);
  const saved = await state.service.createModel(modelInput(provider.id, { reasoningFormat: "minimax" }));
  assert.equal(saved.reasoningFormat, "minimax");
  assert.equal(state.models.get(saved.id)?.reasoningFormat, "minimax");
});

test("changing an adapter cannot reinterpret models already registered against the provider", async () => {
  for (const adapterId of [null, "deepseek"] as const) {
    const provider = providerRow({ adapterId });
    const model = modelRow(provider.id);
    const state = fixture([provider], [model]);
    await assert.rejects(
      state.service.updateProvider(provider.id, updateProviderBodySchema.parse({ adapterId: "anthropic" }), principal),
      { code: "CONFLICT" },
    );
    assert.equal(state.writes.providers, 0);
    assert.deepEqual(state.providers.get(provider.id), provider);
    assert.deepEqual(state.models.get(model.id), model);
  }
});

test("a provider can change its gateway or name without altering its registered models", async () => {
  const provider = providerRow();
  const model = modelRow(provider.id);
  const state = fixture([provider], [model]);
  const updated = await state.service.updateProvider(
    provider.id,
    updateProviderBodySchema.parse({
      adapterId: "deepseek",
      name: "Renamed",
      baseUrl: "https://new-gateway.example/v1",
    }),
    principal,
  );
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.baseUrl, "https://new-gateway.example/v1");
  assert.equal(updated.protocol, "openai");
  assert.deepEqual(state.models.get(model.id), model);
});

test("legacy protocol-only updates cannot reinterpret models already registered against the provider", async () => {
  const provider = providerRow({ adapterId: null });
  const model = modelRow(provider.id, { reasoningFormat: "minimax" });
  const state = fixture([provider], [model]);
  await assert.rejects(
    state.service.updateProvider(provider.id, updateProviderBodySchema.parse({ protocol: "anthropic" }), principal),
    { code: "CONFLICT" },
  );
  assert.equal(state.writes.providers, 0);
  assert.deepEqual(state.providers.get(provider.id), provider);
  assert.deepEqual(state.models.get(model.id), model);
});

test("provider updates reject a protocol incompatible with the selected adapter", async () => {
  const provider = providerRow();
  const state = fixture([provider]);
  await assert.rejects(
    state.service.updateProvider(provider.id, updateProviderBodySchema.parse({ protocol: "anthropic" }), principal),
    { code: "VALIDATION_ERROR" },
  );
  assert.equal(state.writes.providers, 0);
});

test("an adapter may be selected before registering any models", async () => {
  const provider = providerRow({ adapterId: null });
  const state = fixture([provider]);
  const updated = await state.service.updateProvider(
    provider.id,
    updateProviderBodySchema.parse({ adapterId: "anthropic" }),
    principal,
  );
  assert.equal(updated.adapterId, "anthropic");
  assert.equal(updated.protocol, "anthropic");
  assert.equal(updated.baseUrl, customBaseURL);
});
