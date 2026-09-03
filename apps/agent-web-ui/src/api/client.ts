import type {
  BindProjectWorkspace,
  CreateConversation,
  CreateProject,
  DecisionResponse,
  ProjectInstructions,
  SendMessage,
  UpdateProject,
} from "@nova/protocol";
import {
  abortConversation,
  bindProjectWorkspace,
  createConversation,
  createProject,
  createUpload,
  deleteProject,
  deleteConversation,
  deleteRunner,
  deleteRunnerToken,
  estimateConversationPromptTokens,
  createRunnerToken,
  compactConversation,
  clearConversationContext,
  getRunnerConnectionInfo,
  getConversationContext,
  listAvailableModels,
  listConversations,
  listMessages,
  listProjects,
  listRunnerDirectories,
  listRunners,
  listRunnerTokens,
  resolveDecision,
  sendMessage,
  setProjectInstructions,
  updateProject,
  uploadRunnerFile,
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
    setProjectInstructions: (projectId: string, input: ProjectInstructions) => setProjectInstructions(projectId, input),
    deleteProject: (projectId: string) => deleteProject(projectId, { headers: { "X-Confirm-Delete": projectId } }),
    deleteConversation,
    getRunnerConnectionInfo,
    listRunnerTokens,
    createRunnerToken,
    deleteRunnerToken,
    listRunnerDirectories,
    listRunners,
    listAvailableModels,
    uploadFile: async (file: File) => {
      const mimeType = file.type || "application/octet-stream";
      const { upload, download } = await createUpload({ name: file.name });
      let response: Response;
      try {
        response = await fetch(upload, { method: "PUT", headers: { "Content-Type": mimeType }, body: file });
      } catch {
        throw new ApiClientError(0, "UPLOAD_NETWORK_ERROR", "无法连接附件存储，请检查网络后重试");
      }
      if (!response.ok) {
        throw new ApiClientError(
          response.status,
          "UPLOAD_FAILED",
          response.status === 403 ? "上传凭证已失效，请重试" : `附件上传失败（${response.status}）`,
        );
      }
      return { url: download, name: file.name, size: file.size, mimeType };
    },
    uploadRunnerFile,
    deleteRunner,
    listConversations: (projectId?: string) => listConversations({ limit: 100, ...(projectId ? { projectId } : {}) }),
    createConversation: (input: CreateConversation) => {
      const { title, projectId, runnerId, modelConfig, modelId } = input;
      return createConversation({
        ...(title === undefined ? {} : { title }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(runnerId === undefined ? {} : { runnerId }),
        ...(modelConfig === undefined ? {} : { modelConfig: modelConfigBody(modelConfig) }),
        ...(modelId === undefined ? {} : { modelId }),
      });
    },
    listMessages: (conversationId: string) => listMessages(conversationId, { limit: 100 }),
    sendMessage: (conversationId: string, input: SendMessage) => {
      const { queue, reasoningEffort, modelConfig, modelId, ...required } = input;
      return sendMessage(conversationId, {
        ...required,
        ...(queue === undefined ? {} : { queue }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(modelConfig === undefined ? {} : { modelConfig: modelConfigBody(modelConfig) }),
        ...(modelId === undefined ? {} : { modelId }),
      });
    },
    abortConversation,
    getConversationContext,
    estimateConversationPromptTokens: (conversationId: string, text: string) =>
      estimateConversationPromptTokens(conversationId, { text }),
    compactConversation,
    clearConversationContext,
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
