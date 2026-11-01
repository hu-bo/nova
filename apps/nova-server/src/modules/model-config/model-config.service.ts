import type { ServiceTransaction } from "../../shared/scope.js";
import type { ModelConfigRepository } from "./model-config.repository.js";
import { DomainError } from "../../shared/domain-error.js";
import type { Principal } from "../identity/index.js";
import { createCredentialCipher, maskCredential } from "./credential-cipher.js";
import type { ModelRow, ProviderRow } from "./model-config.repository.js";
import {
  modelConfigurationSchema,
  type CreateModelInput,
  type CreateProviderInput,
  type UpdateModelInput,
  type UpdateProviderInput,
} from "./model-config.schema.js";

export class ModelConfigService {
  private readonly credentialCipher: ReturnType<typeof createCredentialCipher>;

  constructor(
    private readonly repository: ModelConfigRepository,
    encryptionKey: string | undefined,
    private readonly transaction: ServiceTransaction<{ repository: ModelConfigRepository }>,
  ) {
    this.credentialCipher = createCredentialCipher(encryptionKey);
  }

  async listProviders() {
    return (await this.repository.listProviders()).map(toProviderDto);
  }

  async createProvider(input: CreateProviderInput, principal: Principal) {
    const provider = await this.repository.createProvider({
      protocol: input.protocol,
      name: input.name,
      baseUrl: input.baseUrl,
      credentialCiphertext: this.credentialCipher.encrypt(input.credential),
      credentialMasked: maskCredential(input.credential),
      enabled: input.enabled,
      isPublic: input.isPublic,
      ownerId: input.isPublic ? null : principal.localUserId,
    });
    return toProviderDto(provider);
  }

  async updateProvider(id: string, input: UpdateProviderInput, principal: Principal) {
    return this.transaction(async ({ repository }) => {
      const current = await repository.lockProvider(id);
      if (!current) throw new DomainError("NOT_FOUND", "Provider not found");
      const patch: Parameters<ModelConfigRepository["updateProvider"]>[1] = {};
      if (input.protocol !== undefined) patch.protocol = input.protocol;
      if (input.name !== undefined) patch.name = input.name;
      if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl;
      if (input.enabled !== undefined) patch.enabled = input.enabled;
      if (input.isPublic !== undefined) {
        patch.isPublic = input.isPublic;
        patch.ownerId = input.isPublic ? null : (current.ownerId ?? principal.localUserId);
      }
      const credential = input.credential?.trim();
      if (credential) {
        patch.credentialCiphertext = this.credentialCipher.encrypt(credential);
        patch.credentialMasked = maskCredential(credential);
      }
      const provider = await repository.updateProvider(id, patch);
      if (!provider) throw new DomainError("NOT_FOUND", "Provider not found");
      return toProviderDto(provider);
    });
  }

  async deleteProvider(id: string): Promise<void> {
    return this.transaction(async ({ repository }) => {
      if (!(await repository.deleteProvider(id))) throw new DomainError("NOT_FOUND", "Provider not found");
    });
  }

  async listModels() {
    return (await this.repository.listModels()).map(toModelDto);
  }

  async createModel(input: CreateModelInput) {
    return this.transaction(async ({ repository }) => {
      const provider = await repository.lockProvider(input.providerId);
      if (!provider) throw new DomainError("NOT_FOUND", "Provider not found");
      if (input.enabled && !provider.enabled) {
        throw new DomainError("CONFLICT", "Enable the provider before enabling a model");
      }
      if (await repository.isModelNameTaken(input.publicName)) {
        throw new DomainError("CONFLICT", "This public model name is already reserved");
      }
      const model = await repository.createModel(toModelWrite(input));
      return this.getModelDto(model.id, repository);
    });
  }

  async updateModel(id: string, input: UpdateModelInput) {
    return this.transaction(async ({ repository }) => {
      const current = await repository.findModel(id);
      if (!current) throw new DomainError("NOT_FOUND", "Model not found");
      const model = modelConfigurationSchema.parse({
        publicName: input.publicName ?? current.publicName,
        providerId: input.providerId ?? current.providerId,
        upstreamName: input.upstreamName ?? current.upstreamName,
        contextWindow: input.contextWindow ?? Number(current.contextWindow),
        maxOutput: input.maxOutput ?? Number(current.maxOutput),
        thinkingLevels: input.thinkingLevels ?? current.thinkingLevels,
        parallelToolCalls: input.parallelToolCalls ?? current.parallelToolCalls,
        reasoningFormat: input.reasoningFormat ?? current.reasoningFormat,
        inputModalities: input.inputModalities ?? current.inputModalities,
        enabled: input.enabled ?? current.enabled,
        priceIn: input.priceIn ?? current.priceIn,
        priceOut: input.priceOut ?? current.priceOut,
        priceCacheRead: input.priceCacheRead ?? current.priceCacheRead,
      });
      const provider = await repository.lockProvider(model.providerId);
      if (!provider) throw new DomainError("NOT_FOUND", "Provider not found");
      if (model.enabled && !provider.enabled) {
        throw new DomainError("CONFLICT", "Enable the provider before enabling a model");
      }
      if (await repository.isModelNameTaken(model.publicName, id)) {
        throw new DomainError("CONFLICT", "This public model name is already reserved");
      }
      await repository.updateModel(id, toModelWrite(model));
      return this.getModelDto(id, repository);
    });
  }

  async deleteModel(id: string): Promise<void> {
    if (!(await this.repository.deleteModel(id))) throw new DomainError("NOT_FOUND", "Model not found");
  }

  private async getModelDto(id: string, repository: ModelConfigRepository) {
    const model = await repository.findModel(id);
    if (!model) throw new DomainError("NOT_FOUND", "Model not found");
    return toModelDto(model);
  }
}

function toProviderDto(provider: ProviderRow) {
  return {
    id: provider.id,
    protocol: provider.protocol,
    name: provider.name,
    baseUrl: provider.baseUrl,
    credentialMasked: provider.credentialMasked,
    enabled: provider.enabled,
    isPublic: provider.isPublic,
    ownerId: provider.ownerId,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

function toModelDto(model: ModelRow & { providerName: string }) {
  return {
    id: model.id,
    publicName: model.publicName,
    providerId: model.providerId,
    providerName: model.providerName,
    upstreamName: model.upstreamName,
    contextWindow: Number(model.contextWindow),
    maxOutput: Number(model.maxOutput),
    thinkingLevels: [...model.thinkingLevels],
    parallelToolCalls: model.parallelToolCalls,
    reasoningFormat: model.reasoningFormat,
    inputModalities: [...model.inputModalities],
    enabled: model.enabled,
    priceIn: model.priceIn,
    priceOut: model.priceOut,
    priceCacheRead: model.priceCacheRead,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}

function toModelWrite(input: CreateModelInput) {
  return {
    ...input,
    contextWindow: String(input.contextWindow),
    maxOutput: String(input.maxOutput),
  };
}
