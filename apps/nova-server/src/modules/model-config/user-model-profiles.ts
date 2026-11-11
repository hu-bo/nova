import type { ServiceTransaction } from "../../shared/scope.js";
import { createModelConfigRepository, type ModelConfigRepository } from "./model-config.repository.js";
import { createScope, defineService } from "../../shared/scope.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requirePrincipal } from "../../shared/authorization.js";
import { DomainError } from "../../shared/domain-error.js";
import { errorResponses } from "../../shared/error.schema.js";
import { okEnvelope, success } from "../../shared/response.schema.js";
import { createCredentialCipher, maskCredential } from "../../shared/credential-cipher.js";
import { type ModelRow, type ProviderRow } from "./model-config.repository.js";
import { providerProtocolSchema, reasoningFormatSchema, thinkingLevelSchema } from "./model-config.schema.js";
import { modelProviders, resolveProviderId, type ModelProviderDefinition } from "@nnova/harness/plugins/model-ai-sdk";

export const availableModelSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  name: z.string(),
  provider: providerProtocolSchema,
  providerName: z.string(),
  endpoint: z.string().optional(),
  editable: z.boolean(),
  contextWindow: z.number().int(),
  maxOutput: z.number().int(),
  reasoningFormat: reasoningFormatSchema,
  thinkingLevels: z.array(thinkingLevelSchema),
  parallelToolCalls: z.boolean(),
  supportsImages: z.boolean(),
  priceVersion: z.string(),
  capabilities: z.array(z.string()),
  deprecated: z.boolean(),
});
const endpointSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  }, "Use HTTPS or a local HTTP endpoint");
const profileFieldsSchema = z
  .object({
    providerName: z.string().trim().min(1).max(80),
    provider: providerProtocolSchema,
    endpoint: endpointSchema,
    model: z.string().trim().min(1).max(150),
    contextWindow: z.number().int().positive().max(10_000_000),
    maxOutput: z.number().int().positive().max(10_000_000),
    thinkingLevels: z.array(thinkingLevelSchema).max(5),
    reasoningFormat: reasoningFormatSchema,
    parallelToolCalls: z.boolean(),
    supportsImages: z.boolean(),
    credential: z.string().trim().min(1).max(4096).optional(),
  })
  .strict();
function validateProfile(value: z.infer<typeof profileFieldsSchema>, ctx: z.RefinementCtx) {
  if (value.maxOutput > value.contextWindow)
    ctx.addIssue({ code: "custom", path: ["maxOutput"], message: "Cannot exceed context window" });
  if (new Set(value.thinkingLevels).size !== value.thinkingLevels.length)
    ctx.addIssue({ code: "custom", path: ["thinkingLevels"], message: "Thinking levels cannot repeat" });
  if ((value.reasoningFormat === "none") !== (value.thinkingLevels.length === 0))
    ctx.addIssue({
      code: "custom",
      path: ["thinkingLevels"],
      message: "Thinking levels must match the reasoning format",
    });
}
export const createUserModelProfileSchema = profileFieldsSchema
  .extend({ credential: z.string().trim().min(1).max(4096) })
  .superRefine(validateProfile);
export const updateUserModelProfileSchema = profileFieldsSchema.superRefine(validateProfile);
type ProfileInput = z.infer<typeof updateUserModelProfileSchema>;

export class UserModelProfilesService {
  private readonly cipher: ReturnType<typeof createCredentialCipher>;
  constructor(
    private readonly repository: ModelConfigRepository,
    encryptionKey: string | undefined,
    private readonly transaction: ServiceTransaction<{ repository: ModelConfigRepository }>,
  ) {
    this.cipher = createCredentialCipher(encryptionKey);
  }
  async list(owner: string) {
    return (await this.repository.listVisibleModels(owner)).map((row) => modelDto(row, owner));
  }
  async validateSelection(id: string | null, owner: string, effort: string | null) {
    if (!id) return;
    const model = (await this.list(owner)).find((entry) => entry.id === id);
    if (!model) throw new DomainError("NOT_FOUND", "Selected model is unavailable", { reason: "MODEL_UNAVAILABLE" });
    const selectedEffort = thinkingLevelSchema.safeParse(effort);
    if (effort && (!selectedEffort.success || !model.thinkingLevels.includes(selectedEffort.data)))
      throw new DomainError("INFERENCE_STRENGTH_UNAVAILABLE", "Selected reasoning effort is not supported");
  }
  async resolve(id: string | null, owner: string, effort: string | null) {
    const available = await this.repository.listVisibleModels(owner);
    const row = id ? available.find((entry) => entry.model.id === id) : available[0];
    if (!row?.provider.credentialCiphertext)
      throw new DomainError("NOT_FOUND", "Selected model is unavailable", { reason: "MODEL_UNAVAILABLE" });
    await this.validateSelection(row.model.id, owner, effort);
    return { ...row, credential: this.cipher.decrypt(row.provider.credentialCiphertext) };
  }
  async save(owner: string, input: ProfileInput, id?: string) {
    return this.transaction(async ({ repository }) => {
      const provider = {
        name: input.providerName,
        protocol: input.provider,
        baseUrl: input.endpoint,
        enabled: true,
        ...(input.credential
          ? {
              credentialCiphertext: this.cipher.encrypt(input.credential),
              credentialMasked: maskCredential(input.credential),
            }
          : {}),
      };
      const model = {
        upstreamName: input.model,
        contextWindow: String(input.contextWindow),
        maxOutput: String(input.maxOutput),
        thinkingLevels: input.thinkingLevels,
        parallelToolCalls: input.parallelToolCalls,
        reasoningFormat: input.reasoningFormat,
        inputModalities: input.supportsImages ? ["text" as const, "image" as const] : ["text" as const],
        enabled: true,
      };
      const row = id
        ? await repository.updatePrivateProfile(id, owner, provider, model)
        : await repository.createPrivateProfile(
            {
              ...provider,
              isPublic: false,
              ownerId: owner,
              credentialCiphertext: provider.credentialCiphertext!,
              credentialMasked: provider.credentialMasked!,
            },
            { ...model, publicName: `profile-${randomUUID()}`, priceIn: "0", priceOut: "0", priceCacheRead: "0" },
          );
      if (!row) throw new DomainError("NOT_FOUND", "Private model profile not found");
      return modelDto(row, owner);
    });
  }
  async remove(id: string, owner: string) {
    return this.transaction(async ({ repository }) => {
      if (!(await repository.deletePrivateProfile(id, owner)))
        throw new DomainError("NOT_FOUND", "Private model profile not found");
    });
  }
}
function modelDto(row: { model: ModelRow; provider: ProviderRow }, owner: string) {
  const { model, provider } = row;
  const editable = !provider.isPublic && provider.ownerId === owner;
  const adapter: ModelProviderDefinition =
    modelProviders[
      resolveProviderId({
        ...(provider.adapterId ? { provider: provider.adapterId } : {}),
        protocol: provider.protocol,
        reasoningFormat: model.reasoningFormat,
      })
    ];
  const thinkingLevels = model.thinkingLevels.filter((level) => adapter.thinkingLevels.includes(level));
  return availableModelSchema.parse({
    id: model.id,
    label: model.upstreamName,
    name: model.upstreamName,
    provider: provider.protocol,
    providerName: provider.name,
    ...(editable ? { endpoint: provider.baseUrl } : {}),
    editable,
    contextWindow: Number(model.contextWindow),
    maxOutput: Number(model.maxOutput),
    reasoningFormat: thinkingLevels.length ? adapter.reasoningFormat : "none",
    thinkingLevels,
    parallelToolCalls: model.parallelToolCalls,
    supportsImages: model.inputModalities.includes("image"),
    priceVersion: model.updatedAt.toISOString(),
    capabilities: [
      "tools",
      ...(model.inputModalities.includes("image") ? ["vision"] : []),
      ...(thinkingLevels.length ? ["reasoning"] : []),
    ],
    deprecated: false,
  });
}
export function createUserModelProfilesService(app: FastifyInstance) {
  return createScope(app.db).get(
    defineService(
      { repository: createModelConfigRepository(app.db) },
      ({ repository, transaction }) =>
        new UserModelProfilesService(repository, app.credentialEncryptionKey, transaction),
    ),
  );
}
export async function userModelProfilesModule(app: FastifyInstance) {
  const service = createUserModelProfilesService(app);
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ id: z.string().uuid() }).strict();
  const errors = errorResponses(400, 401, 404, 409, 500);
  typed.post(
    "/model-profiles",
    {
      schema: {
        operationId: "createUserModelProfile",
        tags: ["models"],
        body: createUserModelProfileSchema,
        response: { 200: okEnvelope(availableModelSchema), ...errors },
      },
    },
    async (request) => success(await service.save(requirePrincipal(request).localUserId, request.body)),
  );
  typed.patch(
    "/model-profiles/:id",
    {
      schema: {
        operationId: "updateUserModelProfile",
        tags: ["models"],
        params,
        body: updateUserModelProfileSchema,
        response: { 200: okEnvelope(availableModelSchema), ...errors },
      },
    },
    async (request) =>
      success(await service.save(requirePrincipal(request).localUserId, request.body, request.params.id)),
  );
  typed.delete(
    "/model-profiles/:id",
    {
      schema: {
        operationId: "deleteUserModelProfile",
        tags: ["models"],
        params,
        response: { 200: okEnvelope(z.null()), ...errors },
      },
    },
    async (request) => {
      await service.remove(request.params.id, requirePrincipal(request).localUserId);
      return success(null);
    },
  );
}
