import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { decimalSequenceSchema } from "@nova/agent-ui-contracts";
import { requirePrincipal } from "../../shared/authorization.js";
import { errorResponses } from "../../shared/error.schema.js";
import { SseSubscriber } from "../../transport/sse.js";
import { followEvents } from "./event-stream.js";
import type { EventService } from "./event.service.js";
export async function eventRoutes(app: FastifyInstance, service: EventService) {
  app
    .withTypeProvider<ZodTypeProvider>()
    .get(
      "/conversations/:id/events",
      {
        schema: {
          operationId: "subscribeConversationEvents",
          tags: ["events"],
          params: z.object({ id: z.uuid() }).strict(),
          querystring: z.object({ cursor: decimalSequenceSchema.optional() }).strict(),
          response: errorResponses(400, 401, 404, 410, 500),
        },
      },
      async (request, reply) => {
        const owner = requirePrincipal(request).localUserId;
        const id = request.params.id;
        const header = request.headers["last-event-id"];
        const cursor = await service.resolveCursor({
          conversationId: id,
          ownerUserId: owner,
          ...(request.query.cursor !== undefined ? { cursor: request.query.cursor } : {}),
          ...(typeof header === "string" ? { lastEventId: header } : {}),
        });
        reply.hijack();
        reply.raw.setHeader("Content-Type", "text/event-stream");
        reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
        reply.raw.setHeader("Connection", "keep-alive");
        reply.raw.setHeader("X-Accel-Buffering", "no");
        reply.raw.flushHeaders?.();
        const heartbeat = setInterval(() => {
          if (!reply.raw.writableEnded) reply.raw.write(": keepalive\n\n");
        }, app.config.SSE_HEARTBEAT_MS);
        const subscriber = new SseSubscriber(
          reply,
          {
            heartbeatMs: app.config.SSE_HEARTBEAT_MS,
            queueFrames: app.config.SSE_QUEUE_FRAMES,
            queueBytes: app.config.SSE_QUEUE_BYTES,
          },
          heartbeat,
        );
        reply.raw.on("close", () => subscriber.close());
        request.raw.on("aborted", () => subscriber.close());
        void followEvents({ service, subscriber, conversationId: id, cursor }).catch(() => {
          app.log.error({ conversationId: id }, "SSE outbox read failed");
          subscriber.close();
        });
        subscriber.sendComment("ready");
        return reply;
      },
    );
}
