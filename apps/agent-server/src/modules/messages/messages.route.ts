import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ApiErrorSchema, ChatMessageSchema, MessageQuerySchema, SendMessageSchema, pageSchema } from "@nova/protocol";
import type { AgentStore } from "../../store.js";
import type { EventHub } from "../runtime/event-hub.js";
import type { ConversationRuntimes } from "../runtime/runtime-registry.js";
import { createMessagesService } from "./messages.service.js";
import type { ModelConfigStore } from "../model-config/model-config.store.js";
import type { CredentialCipher } from "../model-config/credential.js";

const IdParams = z.object({ id: z.uuid() });
const EventHeaders = z.object({ "last-event-id": z.string().optional() });

export function messageRoutes(
  app: FastifyInstance,
  store: AgentStore,
  runtimes: ConversationRuntimes,
  events: EventHub,
  models: ModelConfigStore,
  cipher: CredentialCipher,
): void {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const messages = createMessagesService(store, runtimes, models, cipher);

  server.get("/conversations/:id/messages", {
    schema: {
      operationId: "listMessages",
      tags: ["messages"],
      security: [{ bearerAuth: [] }],
      params: IdParams,
      querystring: MessageQuerySchema,
      response: { 200: pageSchema(ChatMessageSchema), 400: ApiErrorSchema, 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, request => messages.list(request.userId, request.params.id, request.query));

  server.post("/conversations/:id/messages", {
    schema: {
      operationId: "sendMessage",
      tags: ["messages"],
      security: [{ bearerAuth: [] }],
      params: IdParams,
      body: SendMessageSchema,
      response: { 202: z.null(), 400: ApiErrorSchema, 401: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema, 503: ApiErrorSchema },
    },
  }, async (request, reply) => {
    await messages.send(request.userId, request.params.id, request.body);
    return reply.code(202).send(null);
  });

  server.post("/conversations/:id/abort", {
    schema: {
      operationId: "abortConversation",
      tags: ["messages"],
      security: [{ bearerAuth: [] }],
      params: IdParams,
      response: { 204: z.null(), 401: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
    },
  }, async (request, reply) => {
    await messages.abort(request.userId, request.params.id);
    return reply.code(204).send(null);
  });

  server.get("/conversations/:id/events", {
    schema: {
      operationId: "subscribeConversationEvents",
      tags: ["events"],
      security: [{ bearerAuth: [] }],
      params: IdParams,
      headers: EventHeaders,
      response: { 401: ApiErrorSchema, 404: ApiErrorSchema },
    },
  }, async (request, reply) => {
    await store.routeConversation(request.userId, request.params.id);
    const replay = events.replay(request.params.id, request.headers["last-event-id"]);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    if (replay.kind === "resync") {
      writeSse(reply.raw, null, { type: "error", code: "RESYNC", message: "Event history is no longer available" });
    } else {
      for (const envelope of replay.events) writeSse(reply.raw, envelope.id, envelope.event);
    }
    const unsubscribe = events.subscribe(request.params.id, envelope => writeSse(reply.raw, envelope.id, envelope.event));
    const heartbeat = setInterval(() => reply.raw.write(":ka\n\n"), 15_000);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.once("close", close);
    reply.raw.once("close", close);
  });
}

function writeSse(stream: NodeJS.WritableStream, id: string | null, event: unknown): void {
  if (id) stream.write(`id: ${id}\n`);
  stream.write(`data: ${JSON.stringify(event)}\n\n`);
}
