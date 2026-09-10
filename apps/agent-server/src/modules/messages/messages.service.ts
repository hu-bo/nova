import { randomUUID } from "node:crypto";
import type { ChatMessage, SendMessage } from "@nova/protocol";
import type { AgentStore, MessageRow } from "../../store.js";
import type { ConversationRuntimes } from "../runtime/runtime-registry.js";
import type { ModelConfigStore } from "../model-config/model-config.store.js";
import { resolveCatalogModel } from "../model-config/model-config.store.js";
import type { CredentialCipher } from "../model-config/credential.js";
import type { ContentPart } from "@nova/agent-core";
import type { UploadStorage } from "../uploads/upload-storage.js";
import { conflict, invalidInput, uploadUnavailable } from "../../errors.js";

export function createMessagesService(
  store: AgentStore,
  runtimes: ConversationRuntimes,
  models: ModelConfigStore,
  cipher: CredentialCipher,
  uploads?: UploadStorage,
) {
  const view = (message: MessageRow): ChatMessage => ({
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    blocks: message.blocks,
    status: message.status,
    createdAt: message.createdAt.getTime(),
  });

  return {
    async run(userId: string, id: string) {
      await store.routeConversation(userId, id);
      return runtimes.status ? runtimes.status(id) : null;
    },
    async resume(userId: string, id: string) {
      const route = await store.routeConversation(userId, id);
      if (!runtimes.resume) throw conflict("Run recovery is unavailable");
      await runtimes.resume(route);
    },
    async list(userId: string, conversationId: string, query: { before?: string; limit: number }) {
      const result = await store.listMessages({ userId, conversationId, ...query });
      const items: ChatMessage[] = [];
      for (const row of result.items) {
        const message = view(row);
        message.blocks = await Promise.all(
          message.blocks.map(async (block) => {
            if (block.type !== "image") return block;
            const { url: _url, ...image } = block;
            try {
              return { ...image, url: await uploads?.imageUrl(userId, image.key) };
            } catch {
              return image;
            }
          }),
        );
        items.push(message);
      }
      return { items, nextCursor: result.nextCursor };
    },
    async send(userId: string, conversationId: string, input: SendMessage) {
      let route = await store.routeConversation(userId, conversationId);
      const currentRun = await runtimes.status?.(conversationId);
      if (currentRun?.status === "paused") throw conflict("任务已暂停，请先继续或停止当前任务");
      const modelConfig =
        input.modelConfig ??
        (input.modelId
          ? await resolveCatalogModel(models, cipher, userId, input.modelId)
          : route.conversation.modelConfig);
      const blocks: ChatMessage["blocks"] = input.text ? [{ type: "text", text: input.text }] : [];
      const content: ContentPart[] = input.text ? [{ type: "text", text: input.text }] : [];
      if (input.images?.length) {
        if (!modelConfig.inputModalities.includes("image"))
          throw invalidInput("当前模型不支持图片，请选择支持图片的模型");
        if (!uploads) throw uploadUnavailable();
        for (const image of input.images) {
          const resolved = await uploads.readImage(userId, image.key);
          content.push({ type: "image", ...resolved });
          blocks.push({ type: "image", key: image.key, name: image.name, mimeType: resolved.mimeType });
        }
      }
      if (input.modelConfig || input.modelId) {
        await store.updateConversationModel({ userId, id: conversationId, modelConfig });
        runtimes.invalidate(conversationId);
        route = await store.routeConversation(userId, conversationId);
      }
      await store.appendMessage({
        id: input.requestId ?? randomUUID(),
        conversationId,
        role: "user",
        blocks,
        status: "done",
        createdAt: new Date(),
      });
      if (route.conversation.title === "New conversation") {
        await store.setConversationTitleIfUntitled({
          userId,
          id: conversationId,
          title: titleFromMessage(input.text || input.images?.[0]?.name || ""),
        });
      }
      await runtimes.send(
        route,
        input.images?.length ? content : input.text,
        input.queue,
        input.reasoningEffort,
        input.requestId,
      );
    },
    async abort(userId: string, conversationId: string) {
      await store.routeConversation(userId, conversationId);
      await runtimes.abort(conversationId);
    },
    async context(userId: string, conversationId: string) {
      const route = await store.routeConversation(userId, conversationId);
      return runtimes.context(route);
    },
    async estimatePrompt(userId: string, conversationId: string, text: string) {
      const route = await store.routeConversation(userId, conversationId);
      return runtimes.estimatePrompt(route, text);
    },
    async compact(userId: string, conversationId: string) {
      const route = await store.routeConversation(userId, conversationId);
      const result = await runtimes.compact(route);
      return {
        compacted: result.replacedFrom !== null,
        summarized: result.summarized,
        context: await runtimes.context(route),
      };
    },
    async clear(userId: string, conversationId: string) {
      const route = await store.routeConversation(userId, conversationId);
      return {
        context: await runtimes.clear(route, () => store.clearConversationContext({ userId, id: conversationId })),
      };
    },
  };
}

function titleFromMessage(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized || "New conversation";
}
