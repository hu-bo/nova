import type { ComposerSubmission } from "@nova/chat-ui";
import type { ChatMessage, DecisionResponse } from "@nova/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { ApiClientError, errorMessage } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { useAuth } from "../auth/provider.js";
import { useModelSettings } from "../pages/settings/model/provider.js";
import { useConversationStore } from "./store.js";
import type { QueuedMessage } from "./reducer.js";

export interface RunnerAttachmentMetadata {
  runnerId: string;
  path: string;
}

export function useConversationMutations(
  conversationId: string,
  modelProfileId: string,
  ensureStreamConnected: () => Promise<void>,
) {
  const { api } = useAuth();
  const models = useModelSettings();
  const queryClient = useQueryClient();
  const { state, dispatch } = useConversationStore(conversationId);

  const refreshLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.conversationLists, refetchType: "none" });
  }, [queryClient]);

  const sendMutation = useMutation({
    mutationFn: async ({
      submission,
      retryId,
    }: {
      submission: ComposerSubmission<RunnerAttachmentMetadata>;
      retryId?: string;
    }) => {
      const model = models.modelSelection(modelProfileId);
      if (!model) throw new Error("当前模型不可用，请选择其他模型或补充 API Key");
      const uploads = await Promise.all([
        ...submission.files.map((file) => api!.uploadFile(file)),
        ...submission.attachments.map((attachment) => api!.uploadRunnerFile(attachment.metadata)),
      ]);
      const attachmentText = uploads
        .map((file) => `[附件：${file.name.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${file.url})`)
        .join("\n");
      const text = [submission.text, attachmentText].filter(Boolean).join("\n\n");
      const wasRunning = state.isRunning;
      const messageId = retryId ?? crypto.randomUUID();
      const request = { text, ...model };
      if (retryId) {
        dispatch({ type: "optimistic.retry", messageId });
      } else {
        const message: ChatMessage = {
          id: messageId,
          conversationId,
          role: "user",
          blocks: [{ type: "text", text }],
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
        await ensureStreamConnected();
        await api!.sendMessage(conversationId, request);
      } catch (error) {
        dispatch({ type: "optimistic.fail", messageId, keepRunning: wasRunning, message: errorMessage(error) });
        throw error;
      }
    },
    onSuccess: refreshLists,
  });

  const abortMutation = useMutation({
    mutationFn: () => api!.abortConversation(conversationId),
    onSuccess: refreshLists,
  });

  const compactMutation = useMutation({
    mutationFn: () => api!.compactConversation(conversationId),
    onSuccess: (result) => dispatch({ type: "context.set", usage: result.context }),
  });

  const clearMutation = useMutation({
    mutationFn: () => api!.clearConversationContext(conversationId),
    onSuccess: (result) => dispatch({ type: "context.set", usage: result.context }),
  });

  const steerMutation = useMutation({
    mutationFn: async (queued: QueuedMessage) => {
      dispatch({ type: "queue.start", messageId: queued.message.id });
      try {
        await ensureStreamConnected();
        await api!.sendMessage(conversationId, { ...queued.request, queue: "steering" });
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
        await api!.sendMessage(conversationId, queued.request);
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

  const runnerMutation = useMutation({
    mutationFn: (runnerId: string) => api!.updateConversationRunner(conversationId, { runnerId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.conversationLists });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });

  return {
    send: (submission: ComposerSubmission<RunnerAttachmentMetadata>) => sendMutation.mutateAsync({ submission }),
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
      const text = source?.blocks.find((block) => block.type === "text")?.text;
      if (!text) return Promise.reject(new Error("找不到可重试的消息内容"));
      return sendMutation.mutateAsync({
        submission: { text, files: [], attachments: [] },
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
    changeRunner: (runnerId: string) => runnerMutation.mutateAsync(runnerId),
    sendMutation,
    abortMutation,
    compactMutation,
    clearMutation,
    steerMutation,
    queuedRunMutation,
    decisionMutation,
    runnerMutation,
  };
}
