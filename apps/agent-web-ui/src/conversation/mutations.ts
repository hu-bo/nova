import type { ComposerSubmission } from "@nova/chat-ui";
import type { ChatMessage, DecisionResponse } from "@nova/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { ApiClientError, errorMessage } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { useAuth } from "../auth/provider.js";
import { useModelSettings } from "../model/provider.js";
import { useConversationStore } from "./store.js";

export function useConversationMutations(conversationId: string, modelProfileId: string) {
  const { api } = useAuth();
  const models = useModelSettings();
  const queryClient = useQueryClient();
  const { state, dispatch } = useConversationStore();

  const refreshLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.conversationLists });
  }, [queryClient]);

  const sendMutation = useMutation({
    mutationFn: async ({
      submission,
      queue,
      retryId,
    }: {
      submission: ComposerSubmission;
      queue?: "steering" | "nextRun";
      retryId?: string;
    }) => {
      const model = models.modelSelection(modelProfileId);
      if (!model) throw new Error("当前模型不可用，请选择其他模型或补充 API Key");
      const uploads = await Promise.all(submission.files.map((file) => api!.uploadFile(file)));
      const attachmentText = uploads
        .map((file) => `[附件：${file.name.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${file.url})`)
        .join("\n");
      const text = [submission.text, attachmentText].filter(Boolean).join("\n\n");
      const wasRunning = state.isRunning;
      const messageId = retryId ?? crypto.randomUUID();
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
        dispatch({ type: "optimistic.add", message });
      }
      try {
        await api!.sendMessage(conversationId, {
          text,
          ...(queue ? { queue } : {}),
          ...model,
        });
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
    send: (submission: ComposerSubmission, queue?: "steering" | "nextRun") =>
      sendMutation.mutateAsync({ submission, ...(queue ? { queue } : {}) }),
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
        submission: { text, files: [] },
        ...(source?.id === messageId ? { retryId: messageId } : {}),
      });
    },
    abort: () => abortMutation.mutateAsync(),
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
    decisionMutation,
    runnerMutation,
  };
}
