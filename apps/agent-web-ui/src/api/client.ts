import type {
  BindProjectWorkspace,
  CreateConversation,
  CreateProject,
  DecisionResponse,
  SendMessage,
  UpdateConversationRunner,
  UpdateProject,
} from "@nova/protocol";
import {
  abortConversation,
  bindProjectWorkspace,
  createConversation,
  createProject,
  deleteProject,
  deleteRunner,
  deleteRunnerToken,
  createRunnerToken,
  getRunnerConnectionInfo,
  listAvailableModels,
  listConversations,
  listMessages,
  listProjects,
  listRunnerDirectories,
  listRunners,
  listRunnerTokens,
  resolveDecision,
  sendMessage,
  updateConversationRunner,
  updateProject,
} from "./generated/agent-server.js";
import { ApiClientError } from "./errors.js";

export { ApiClientError, errorMessage } from "./errors.js";

interface ApiClientOptions {
  accessToken: string;
}

export function createApiClient({ accessToken }: ApiClientOptions) {
  return {
    accessToken,
    listProjects,
    createProject: (input: CreateProject) => createProject(input),
    renameProject: (projectId: string, input: UpdateProject) => updateProject(projectId, input),
    bindProject: (projectId: string, input: BindProjectWorkspace) => bindProjectWorkspace(projectId, input),
    deleteProject: (projectId: string) => deleteProject(projectId, { headers: { "X-Confirm-Delete": projectId } }),
    getRunnerConnectionInfo,
    listRunnerTokens,
    createRunnerToken,
    deleteRunnerToken,
    listRunnerDirectories,
    listRunners,
    listAvailableModels,
    uploadFile: async (file: File) => {
      const body = new FormData();
      body.append("file", file, file.name);
      const response = await fetch("/api/uploads", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        body,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
        throw new ApiClientError(
          response.status,
          payload?.code ?? "UPLOAD_FAILED",
          payload?.message ?? `上传失败（${response.status}）`,
          response.headers.get("x-request-id") ?? undefined,
        );
      }
      return response.json() as Promise<{ url: string; name: string; size: number; mimeType: string }>;
    },
    deleteRunner,
    listConversations: (projectId?: string) => listConversations({ limit: 100, ...(projectId ? { projectId } : {}) }),
    createConversation: (input: CreateConversation) => {
      const { title, projectId, modelConfig, modelId, ...required } = input;
      return createConversation({
        ...required,
        ...(title === undefined ? {} : { title }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(modelConfig === undefined ? {} : { modelConfig: modelConfigBody(modelConfig) }),
        ...(modelId === undefined ? {} : { modelId }),
      });
    },
    updateConversationRunner: (conversationId: string, input: UpdateConversationRunner) =>
      updateConversationRunner(conversationId, input),
    listMessages: (conversationId: string) => listMessages(conversationId, { limit: 100 }),
    sendMessage: (conversationId: string, input: SendMessage) => {
      const { queue, modelConfig, modelId, ...required } = input;
      return sendMessage(conversationId, {
        ...required,
        ...(queue === undefined ? {} : { queue }),
        ...(modelConfig === undefined ? {} : { modelConfig: modelConfigBody(modelConfig) }),
        ...(modelId === undefined ? {} : { modelId }),
      });
    },
    abortConversation,
    resolveDecision: (decisionId: string, input: DecisionResponse) => {
      if (input.kind === "question") return resolveDecision(decisionId, input);
      return resolveDecision(decisionId, {
        kind: input.kind,
        decision: input.decision,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

function modelConfigBody(config: import("@nova/protocol").ModelConfig) {
  return config;
}
