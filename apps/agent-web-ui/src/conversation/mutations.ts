import type { ComposerSubmission } from "@nova/chat-ui";
import type { ChatMessage, DecisionResponse } from "@nova/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { ApiClientError, errorMessage, type ApiClient } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { useAuth } from "../auth/provider.js";
import { useModelSettings } from "../pages/settings/model/provider.js";
import { createUuid } from "../lib/uuid.js";
import { useConversationStore } from "./store.js";
import type { QueuedMessage } from "./reducer.js";
import { messageContent, validateImageAttachments } from "./message-content.js";

export interface RunnerAttachmentMetadata {
  runnerId: string;
  path: string;
}
type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";

interface ConversationMutationOptions {
  conversationId?: string;
  stateId: string;
  modelProfileId: string;
  ensureStreamConnected: (conversationId?: string) => Promise<void>;
  releaseStream: (conversationId: string) => void;
  reasoningEffort?: string;
  draft?: {
    projectId?: string;
    runnerId?: string;
    onCreated: (conversation: { id: string; projectId: string | null }) => void;
  };
}

export function useConversationMutations(options: ConversationMutationOptions) {
  const { conversationId, stateId, modelProfileId, ensureStreamConnected, releaseStream, reasoningEffort, draft } =
    options;
  const { api } = useAuth();
  const models = useModelSettings();
  const queryClient = useQueryClient();
  const { state, dispatch } = useConversationStore(stateId);
  const activeConversationId = useRef(conversationId);
  const pendingCreatedConversation = useRef<Awaited<ReturnType<ApiClient["createConversation"]>> | undefined>(
    undefined,
  );

  const refreshLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.conversationLists, refetchType: "none" });
  }, [queryClient]);

  const sendMutation = useMutation({
    mutationFn: async ({
      submission,
      retryId,
      existingImages = [],
    }: {
      submission: ComposerSubmission<RunnerAttachmentMetadata>;
      retryId?: string;
      existingImages?: Extract<ChatMessage["blocks"][number], { type: "image" }>[];
    }) => {
      const model = models.modelSelection(modelProfileId);
      if (!model) throw new Error("当前模型不可用，请选择其他模型或补充 API Key");
      const supportsImages = models.profiles.find((profile) => profile.id === modelProfileId)?.supportsImages ?? false;
      validateImageAttachments(
        submission.files.map((file) => ({ name: file.name, mimeType: file.type, size: file.size })),
        supportsImages,
      );
      const uploads = await Promise.all([
        ...submission.files.map((file) => api!.uploadFile(file)),
        ...submission.attachments.map((attachment) => api!.uploadRunnerFile(attachment.metadata)),
      ]);
      const { blocks, ...content } = messageContent(submission.text, [...uploads, ...existingImages], supportsImages);
      let targetConversationId = activeConversationId.current;
      let createdConversation = pendingCreatedConversation.current;
      if (!targetConversationId) {
        if (!draft) throw new Error("临时会话缺少创建信息");
        createdConversation = await api!.createConversation({
          ...(draft.projectId ? { projectId: draft.projectId } : {}),
          ...(draft.runnerId ? { runnerId: draft.runnerId } : {}),
          ...model,
        });
        targetConversationId = createdConversation.id;
        activeConversationId.current = targetConversationId;
        pendingCreatedConversation.current = createdConversation;
      }
      const wasRunning = state.isRunning;
      const messageId = retryId ?? createUuid();
      const request = {
        ...content,
        ...model,
        ...(isReasoningEffort(reasoningEffort) ? { reasoningEffort } : {}),
      };
      if (retryId) {
        dispatch({ type: "optimistic.retry", messageId });
      } else {
        const message: ChatMessage = {
          id: messageId,
          conversationId: targetConversationId,
          role: "user",
          blocks,
          status: "done",
          createdAt: Date.now(),
        };
        if (wasRunning) {
          dispatch({ type: "optimistic.queue", queued: { message, request } });
          return;
        }
        dispatch({ type: "optimistic.add", message });
      }
      try {
        await ensureStreamConnected(targetConversationId);
        await api!.sendMessage(targetConversationId, request);
        return { createdConversation };
      } catch (error) {
        if (!conversationId) releaseStream(targetConversationId);
        dispatch({ type: "optimistic.fail", messageId, keepRunning: wasRunning, message: errorMessage(error) });
        throw error;
      }
    },
    onSuccess: async (result) => {
      const createdConversation = result?.createdConversation;
      if (createdConversation) {
        // 先终止旧列表请求，避免它在导航前后覆盖刚创建的会话。
        await queryClient.cancelQueries({ queryKey: queryKeys.conversationLists });
        const listKeys = [queryKeys.conversations()];
        if (createdConversation.projectId) listKeys.push(queryKeys.conversations(createdConversation.projectId));
        for (const queryKey of listKeys) {
          queryClient.setQueryData<Awaited<ReturnType<ApiClient["listConversations"]>>>(queryKey, (current) => ({
            items: [
              createdConversation,
              ...(current?.items.filter((item) => item.id !== createdConversation.id) ?? []),
            ],
            nextCursor: current?.nextCursor ?? null,
          }));
        }
        refreshLists();
        pendingCreatedConversation.current = undefined;
        draft?.onCreated(createdConversation);
        return;
      }
      refreshLists();
    },
  });

  const abortMutation = useMutation({
    mutationFn: () => api!.abortConversation(requireConversationId(activeConversationId.current)),
    onSuccess: refreshLists,
  });

  const compactMutation = useMutation({
    mutationFn: () => api!.compactConversation(requireConversationId(activeConversationId.current)),
    onSuccess: (result) => dispatch({ type: "context.set", usage: result.context }),
  });

  const clearMutation = useMutation({
    mutationFn: () => api!.clearConversationContext(requireConversationId(activeConversationId.current)),
    onSuccess: (result) => dispatch({ type: "context.set", usage: result.context }),
  });

  const steerMutation = useMutation({
    mutationFn: async (queued: QueuedMessage) => {
      dispatch({ type: "queue.start", messageId: queued.message.id });
      try {
        await ensureStreamConnected();
        await api!.sendMessage(requireConversationId(activeConversationId.current), {
          ...queued.request,
          queue: "steering",
        });
      } catch (error) {
        dispatch({
          type: "optimistic.fail",
          messageId: queued.message.id,
          keepRunning: true,
          message: errorMessage(error),
        });
        throw error;
      }
    },
    onSuccess: refreshLists,
  });

  const queuedRunMutation = useMutation({
    mutationFn: async (queued: QueuedMessage) => {
      dispatch({ type: "queue.start", messageId: queued.message.id });
      try {
        await ensureStreamConnected();
        await api!.sendMessage(requireConversationId(activeConversationId.current), queued.request);
      } catch (error) {
        dispatch({
          type: "optimistic.fail",
          messageId: queued.message.id,
          keepRunning: false,
          message: errorMessage(error),
        });
        throw error;
      }
    },
    onSuccess: refreshLists,
  });

  const nextQueued = state.queuedMessages[0];
  const startQueuedRun = queuedRunMutation.mutate;
  useEffect(() => {
    if (!state.queueReady || state.isRunning || !nextQueued || queuedRunMutation.isPending || steerMutation.isPending)
      return;
    startQueuedRun(nextQueued);
  }, [
    nextQueued,
    queuedRunMutation.isPending,
    startQueuedRun,
    state.isRunning,
    state.queueReady,
    steerMutation.isPending,
  ]);

  const decisionMutation = useMutation({
    mutationFn: ({ decisionId, response }: { decisionId: string; response: DecisionResponse }) =>
      api!.resolveDecision(decisionId, response),
    onSuccess: refreshLists,
  });

  return {
    send: async (submission: ComposerSubmission<RunnerAttachmentMetadata>) => {
      await sendMutation.mutateAsync({ submission });
    },
    retry: (messageId: string) => {
      const index = state.messages.findIndex((item) => item.id === messageId);
      const message = state.messages[index];
      const source =
        message?.role === "user"
          ? message
          : state.messages
              .slice(0, index)
              .reverse()
              .find((item) => item.role === "user");
      const text =
        source?.blocks
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n\n") ?? "";
      const existingImages = source?.blocks.filter((block) => block.type === "image") ?? [];
      if (!text && !existingImages.length) return Promise.reject(new Error("找不到可重试的消息内容"));
      return sendMutation.mutateAsync({
        submission: { text, files: [], attachments: [] },
        existingImages,
        ...(source?.id === messageId ? { retryId: messageId } : {}),
      });
    },
    abort: () => abortMutation.mutateAsync(),
    compact: () => compactMutation.mutateAsync(),
    clear: () => clearMutation.mutateAsync(),
    steerQueued: (messageId: string) => {
      const queued = state.queuedMessages.find((item) => item.message.id === messageId);
      if (!queued) return Promise.resolve();
      return steerMutation.mutateAsync(queued);
    },
    removeQueued: (messageId: string) => dispatch({ type: "queue.remove", messageId }),
    resolveDecision: async (response: DecisionResponse) => {
      const request = state.pendingDecision;
      if (!request) return;
      try {
        await decisionMutation.mutateAsync({ decisionId: request.decisionId, response });
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 404) throw new Error("该请求已失效，请重新发起操作");
        throw error;
      }
    },
    sendMutation,
    abortMutation,
    compactMutation,
    clearMutation,
    steerMutation,
    queuedRunMutation,
    decisionMutation,
  };
}

function isReasoningEffort(value: string | undefined): value is ReasoningEffort {
  return value === "off" || value === "low" || value === "medium" || value === "high" || value === "max";
}

function requireConversationId(conversationId: string | undefined) {
  if (!conversationId) throw new Error("会话尚未创建");
  return conversationId;
}
