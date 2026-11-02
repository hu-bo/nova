import { createScope, defineService } from "../../shared/scope.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { bearerToken, requirePrincipal } from "../../shared/authorization.js";
import { errorResponses } from "../../shared/error.schema.js";
import { okEnvelope, success } from "../../shared/response.schema.js";
import { fileListingQuerySchema, remoteFileListingSchema, fileSummaryResponseSchema } from "../runners/index.js";
import { RemoteCredentialTransport, CREDENTIAL_MAX_LENGTH, PASSPHRASE_MAX_LENGTH } from "./credential-transport.js";
import { createRemoteRepository } from "./remote.repository.js";
import { RemoteConnectionService } from "./remote.service.js";
import {
  remoteConnectionBodySchema,
  remoteConnectionParamsSchema,
  remoteConnectionPatchSchema,
  remoteConnectionSchema,
  remoteTestBodySchema,
  remoteTestReceiptSchema,
  remoteTransportKeySchema,
} from "./remote.schema.js";

export { RemoteConnectionService, createRemoteRepository };
export function createRemoteService(app: FastifyInstance) {
  return createScope(app.db).get(
    defineService(
      { repository: createRemoteRepository(app.db) },
      ({ repository }) => new RemoteConnectionService(repository, app.credentialEncryptionKey),
    ),
  );
}
export async function remotesModule(app: FastifyInstance) {
  const service = createRemoteService(app);
  const transport = new RemoteCredentialTransport(app.credentialEncryptionKey);
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const errors = errorResponses(400, 401, 404, 409, 500);
  typed.get(
    "/remote-connections",
    {
      schema: {
        operationId: "listRemoteConnections",
        tags: ["remotes"],
        response: { 200: okEnvelope(z.object({ items: z.array(remoteConnectionSchema) })), ...errors },
      },
    },
    async (request) => success({ items: await service.list(requirePrincipal(request).localUserId) }),
  );
  typed.get(
    "/remote-connections/transport-key",
    {
      schema: {
        operationId: "getRemoteCredentialTransportKey",
        tags: ["remotes"],
        response: { 200: okEnvelope(remoteTransportKeySchema), ...errors },
      },
    },
    async (request) => {
      // 先校验身份: 未通过校验的 token 不能换取传输密钥。
      requirePrincipal(request);
      return success({ key: transport.issueKey(bearerToken(request)), algorithm: "AES-256-GCM" as const });
    },
  );
  typed.post(
    "/remote-connections",
    {
      schema: {
        operationId: "createRemoteConnection",
        tags: ["remotes"],
        body: remoteConnectionBodySchema,
        response: { 200: okEnvelope(remoteConnectionSchema), ...errors },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const token = bearerToken(request);
      const body = request.body;
      return success(
        await service.create(
          {
            ...body,
            credential: transport.open(token, body.credential, CREDENTIAL_MAX_LENGTH),
            ...(body.passphrase === undefined
              ? {}
              : { passphrase: transport.openOptional(token, body.passphrase, PASSPHRASE_MAX_LENGTH) }),
          },
          principal.localUserId,
        ),
      );
    },
  );
  typed.patch(
    "/remote-connections/:id",
    {
      schema: {
        operationId: "updateRemoteConnection",
        tags: ["remotes"],
        params: remoteConnectionParamsSchema,
        body: remoteConnectionPatchSchema,
        response: { 200: okEnvelope(remoteConnectionSchema), ...errors },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const token = bearerToken(request);
      const body = request.body;
      return success(
        await service.update(request.params.id, principal.localUserId, {
          ...body,
          ...(body.credential === undefined
            ? {}
            : { credential: transport.open(token, body.credential, CREDENTIAL_MAX_LENGTH) }),
          ...(body.passphrase === undefined
            ? {}
            : { passphrase: transport.openOptional(token, body.passphrase, PASSPHRASE_MAX_LENGTH) }),
        }),
      );
    },
  );
  typed.delete(
    "/remote-connections/:id",
    {
      schema: {
        operationId: "deleteRemoteConnection",
        tags: ["remotes"],
        params: remoteConnectionParamsSchema,
        response: { 200: okEnvelope(z.null()), ...errors },
      },
    },
    async (request) => {
      await service.remove(request.params.id, requirePrincipal(request).localUserId);
      return success(null);
    },
  );
  typed.post(
    "/remote-connections/:id/test",
    {
      schema: {
        operationId: "testRemoteConnection",
        tags: ["remotes"],
        params: remoteConnectionParamsSchema,
        body: remoteTestBodySchema,
        response: { 200: okEnvelope(remoteTestReceiptSchema), ...errors },
      },
    },
    async (request) =>
      success(await service.test(request.params.id, requirePrincipal(request).localUserId, request.body.fingerprint)),
  );
  typed.get(
    "/remote-connections/:id/files",
    {
      schema: {
        operationId: "listRemoteFiles",
        tags: ["remotes"],
        params: remoteConnectionParamsSchema,
        querystring: fileListingQuerySchema.extend({ path: fileListingQuerySchema.shape.path.default("/") }),
        response: { 200: okEnvelope(remoteFileListingSchema), ...errors },
      },
    },
    async (request) =>
      success(await service.files(request.params.id, requirePrincipal(request).localUserId, request.query.path)),
  );
  typed.post(
    "/remote-connections/:id/files/summary",
    {
      schema: {
        operationId: "summariseRemoteFiles",
        tags: ["remotes"],
        params: remoteConnectionParamsSchema,
        body: z.object({ paths: z.array(z.string().min(1).max(1024)).min(1).max(32) }).strict(),
        response: { 200: okEnvelope(fileSummaryResponseSchema), ...errors },
      },
    },
    async (request) =>
      success(await service.summaries(request.params.id, requirePrincipal(request).localUserId, request.body.paths)),
  );
}
