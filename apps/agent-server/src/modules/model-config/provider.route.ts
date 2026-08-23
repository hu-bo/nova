import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { forbidden } from "../../errors.js";
import type { CredentialCipher } from "./credential.js";
import type { ModelConfigStore, ProviderRow } from "./model-config.store.js";

const ProtocolSchema = z.enum(["openai", "anthropic"]);
const BaseUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:") context.addIssue({ code: "custom", message: "Provider URL must use HTTPS" });
  if (isPrivateHost(url.hostname))
    context.addIssue({ code: "custom", message: "Private provider URLs are not allowed" });
});
const CreateProviderSchema = z.strictObject({
  protocol: ProtocolSchema,
  name: z.string().trim().min(1).max(80),
  baseUrl: BaseUrlSchema,
  credential: z.string().min(1),
  enabled: z.boolean(),
  isPublic: z.boolean(),
});
const UpdateProviderSchema = CreateProviderSchema.partial().refine(
  (input) => Object.keys(input).length > 0,
  "At least one field is required",
);
const ProviderSchema = z.object({
  id: z.uuid(),
  protocol: ProtocolSchema,
  name: z.string(),
  baseUrl: z.url(),
  credentialMasked: z.string(),
  enabled: z.boolean(),
  isPublic: z.boolean(),
  ownerId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const ErrorSchema = z.object({ code: z.string(), message: z.string() });
const ProviderParams = z.object({ providerId: z.uuid() });

export function providerRoutes(app: FastifyInstance, store: ModelConfigStore, cipher: CredentialCipher): void {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const requireAdmin = async (request: { currentUser: { isAdmin: boolean; role: string } | null }) => {
    if (!request.currentUser?.isAdmin && request.currentUser?.role !== "admin") throw forbidden();
  };

  server.get(
    "/providers",
    {
      schema: {
        operationId: "listProviders",
        tags: ["model-config"],
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(ProviderSchema), 401: ErrorSchema, 403: ErrorSchema },
      },
      preHandler: requireAdmin,
    },
    async () => (await store.listProviders()).map((provider) => providerView(provider, cipher)),
  );

  server.post(
    "/providers",
    {
      schema: {
        operationId: "createProvider",
        tags: ["model-config"],
        security: [{ bearerAuth: [] }],
        body: CreateProviderSchema,
        response: { 201: ProviderSchema, 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 409: ErrorSchema },
      },
      preHandler: requireAdmin,
    },
    async (request, reply) => {
      const { credential, ...input } = request.body;
      const provider = await store.createProvider({
        ...input,
        ownerId: request.userId,
        credentialEncrypted: cipher.encrypt(credential),
      });
      return reply.code(201).send(providerView(provider, cipher));
    },
  );

  server.patch(
    "/providers/:providerId",
    {
      schema: {
        operationId: "updateProvider",
        tags: ["model-config"],
        security: [{ bearerAuth: [] }],
        params: ProviderParams,
        body: UpdateProviderSchema,
        response: {
          200: ProviderSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
      preHandler: requireAdmin,
    },
    async (request) => {
      const { credential, ...changes } = request.body;
      const provider = await store.updateProvider({
        id: request.params.providerId,
        ...changes,
        ...(credential ? { credentialEncrypted: cipher.encrypt(credential) } : {}),
      });
      return providerView(provider, cipher);
    },
  );

  server.delete(
    "/providers/:providerId",
    {
      schema: {
        operationId: "deleteProvider",
        tags: ["model-config"],
        security: [{ bearerAuth: [] }],
        params: ProviderParams,
        response: { 204: z.null(), 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
      preHandler: requireAdmin,
    },
    async (request, reply) => {
      await store.deleteProvider(request.params.providerId);
      return reply.code(204).send(null);
    },
  );
}

function providerView(provider: ProviderRow, cipher: CredentialCipher) {
  return {
    id: provider.id,
    protocol: provider.protocol,
    name: provider.name,
    baseUrl: provider.baseUrl,
    credentialMasked: provider.credentialEncrypted ? cipher.masked(provider.credentialEncrypted) : "",
    enabled: provider.enabled,
    isPublic: provider.isPublic,
    ownerId: provider.ownerId,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost")) return true;
  if (/^127\./.test(host) || /^169\.254\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  return Boolean(match && Number(match[1]) === 172 && Number(match[2]) >= 16 && Number(match[2]) <= 31);
}
