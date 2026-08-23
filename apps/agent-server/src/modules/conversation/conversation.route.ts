import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ApiErrorSchema,
  ConversationQuerySchema,
  ConversationSchema,
  CreateConversationSchema,
  UpdateConversationRunnerSchema,
  pageSchema,
} from "@nova/protocol";
import type { AgentStore } from "../../store.js";
import type { RunnerRegistry } from "../runner/registry.js";
import type { ConversationRuntimes } from "../runtime/runtime-registry.js";
import { createConversationService } from "./conversation.service.js";
import type { ModelConfigStore } from "../model-config/model-config.store.js";
import type { CredentialCipher } from "../model-config/credential.js";

const IdParams = z.object({ id: z.uuid() });

export function conversationRoutes(
  app: FastifyInstance,
  store: AgentStore,
  runners: RunnerRegistry,
  runtimes: ConversationRuntimes,
  models: ModelConfigStore,
  cipher: CredentialCipher,
): void {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const conversations = createConversationService(store, runners, runtimes, models, cipher);

  server.post("/conversations", {
    schema: {
      operationId: "createConversation",
      tags: ["conversations"],
      security: [{ bearerAuth: [] }],
      body: CreateConversationSchema,
      response: { 201: ConversationSchema, 400: ApiErrorSchema, 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => reply.code(201).send(await conversations.create(request.userId, request.body)));

  server.get("/conversations", {
    schema: {
      operationId: "listConversations",
      tags: ["conversations"],
      security: [{ bearerAuth: [] }],
      querystring: ConversationQuerySchema,
      response: { 200: pageSchema(ConversationSchema), 400: ApiErrorSchema, 401: ApiErrorSchema },
    },
  }, request => conversations.list(request.userId, request.query));

  server.patch("/conversations/:id/runner", {
    schema: {
      operationId: "updateConversationRunner",
      tags: ["conversations"],
      security: [{ bearerAuth: [] }],
      params: IdParams,
      body: UpdateConversationRunnerSchema,
      response: { 200: ConversationSchema, 400: ApiErrorSchema, 401: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, request => conversations.changeRunner(request.userId, request.params.id, request.body.runnerId));
}
