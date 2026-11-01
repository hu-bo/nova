import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requirePrincipal } from "../../shared/authorization.js";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { okEnvelope, success } from "./conversation.schema.js";
import {
  conversationListSchema,
  conversationParamsSchema,
  conversationSnapshotSchema,
  createConversationBodySchema,
  pendingInputBodySchema,
  pendingInputParamsSchema,
  pendingInputReceiptSchema,
  messagePageSchema,
  messageQuerySchema,
  updateConversationBodySchema,
  updateConversationGoalSchema,
  conversationGoalSchema,
} from "./conversation.schema.js";
import type { ConversationService } from "./conversation.service.js";

/**
 * /api/conversations 路由: 创建 / 列表 / 详情 / 一致 snapshot / 后续输入 / 撤回。
 * - 不区分首条消息端点; historyLength===1 由 snapshot 返回。
 * - 后续输入在已有 active run 时进入持久化队列 (durable, not blocking).
 */
export async function conversationRoutes(app: FastifyInstance, service: ConversationService): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    "/:id/inputs/:inputId/steer",
    {
      schema: {
        operationId: "steerConversationInput",
        tags: ["conversations"],
        params: pendingInputParamsSchema,
        body: z.object({}).strict(),
        response: { 200: okEnvelope(pendingInputReceiptSchema), 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request) =>
      success(
        await service.steerPendingInput({
          conversationId: request.params.id,
          inputId: request.params.inputId,
          ownerUserId: requirePrincipal(request).localUserId,
        }),
      ),
  );
  typed.patch(
    "/:id/goal",
    {
      schema: {
        operationId: "updateConversationGoal",
        tags: ["conversations"],
        params: conversationParamsSchema,
        body: updateConversationGoalSchema,
        response: {
          200: okEnvelope(conversationGoalSchema.nullable()),
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request) =>
      success(
        await service.updateGoal(
          request.params.id,
          requirePrincipal(request).localUserId,
          request.body.action,
          request.body.expectedRevision,
        ),
      ),
  );
  typed.get(
    "/:id/messages",
    {
      schema: {
        operationId: "listConversationMessages",
        tags: ["conversations"],
        params: conversationParamsSchema,
        querystring: messageQuerySchema,
        response: { 200: okEnvelope(messagePageSchema), 404: errorResponseSchema },
      },
    },
    async (request) =>
      success(await service.messages(request.params.id, requirePrincipal(request).localUserId, request.query.before)),
  );
  typed.patch(
    "/:id",
    {
      schema: {
        operationId: "renameConversation",
        tags: ["conversations"],
        params: conversationParamsSchema,
        body: updateConversationBodySchema,
        response: { 200: okEnvelope(conversationListSchema.shape.items.element), 404: errorResponseSchema },
      },
    },
    async (request) =>
      success(await service.rename(request.params.id, requirePrincipal(request).localUserId, request.body.title)),
  );
  typed.delete(
    "/:id",
    {
      schema: {
        operationId: "deleteConversation",
        tags: ["conversations"],
        params: conversationParamsSchema,
        response: { 200: okEnvelope(z.null()), 409: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      await service.maintain(request.params.id, requirePrincipal(request).localUserId, "delete");
      return success(null);
    },
  );
  typed.post(
    "/:id/context/clear",
    {
      schema: {
        operationId: "clearConversationContext",
        tags: ["conversations"],
        params: conversationParamsSchema,
        body: z.object({}).strict(),
        response: {
          200: okEnvelope(z.object({ epoch: z.number().int().positive() }).nullable()),
          409: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) =>
      success(await service.maintain(request.params.id, requirePrincipal(request).localUserId, "clear")),
  );
  typed.get(
    "/",
    {
      schema: {
        operationId: "listConversations",
        tags: ["conversations"],
        querystring: z.object({ limit: z.coerce.number().int().positive().max(100).default(50) }).strict(),
        response: { 200: okEnvelope(conversationListSchema), 401: errorResponseSchema, 500: errorResponseSchema },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return success({ items: await service.list({ ownerUserId: principal.localUserId, limit: request.query.limit }) });
    },
  );

  typed.post(
    "/",
    {
      schema: {
        operationId: "createConversation",
        tags: ["conversations"],
        body: createConversationBodySchema,
        response: {
          200: okEnvelope(conversationListSchema.shape.items.element),
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const dto = await service.create(
        request.body,
        principal.localUserId,
        typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined,
      );
      return success(dto);
    },
  );

  typed.get(
    "/:id/snapshot",
    {
      schema: {
        operationId: "getConversationSnapshot",
        tags: ["conversations"],
        params: conversationParamsSchema,
        response: {
          200: okEnvelope(conversationSnapshotSchema),
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return success(await service.snapshot(request.params.id, principal.localUserId));
    },
  );

  typed.post(
    "/:id/inputs",
    {
      schema: {
        operationId: "appendConversationInput",
        tags: ["conversations"],
        params: conversationParamsSchema,
        body: pendingInputBodySchema,
        response: {
          200: okEnvelope(pendingInputReceiptSchema),
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      return success(
        await service.appendPendingInput({
          conversationId: request.params.id,
          blocks: request.body.blocks,
          mode: request.body.mode,
          ...(request.body.configuration ? { configuration: request.body.configuration } : {}),
          ...(request.body.goal ? { goal: request.body.goal } : {}),
          ownerUserId: principal.localUserId,
          ...(typeof request.headers["idempotency-key"] === "string"
            ? { idempotencyKey: request.headers["idempotency-key"] }
            : {}),
        }),
      );
    },
  );

  typed.delete(
    "/:id/inputs/:inputId",
    {
      schema: {
        operationId: "removeConversationInput",
        tags: ["conversations"],
        params: pendingInputParamsSchema,
        response: {
          200: okEnvelope(z.null()),
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      await service.removePendingInput({
        conversationId: request.params.id,
        inputId: request.params.inputId,
        ownerUserId: principal.localUserId,
      });
      return success(null);
    },
  );
}
