import { configurationSchema, type InputBlock, type Configuration } from "@nova/agent-ui-contracts";
import { DomainError } from "../../shared/domain-error.js";
import type { ProjectBindingService } from "../projects/index.js";
import type { RunnerConnections, RunnerReader } from "../runners/index.js";
import type { ConversationRow, ConversationRepository } from "./conversation.repository.js";
import type { ServiceTransaction } from "../../shared/scope.js";
import type { UserModelProfilesService } from "../model-config/index.js";
import type { RemoteConnectionService } from "../remotes/index.js";
import { conversationSnapshotSchema, type CreateConversationInput } from "./conversation.schema.js";
import { conversationView } from "../runs/index.js";
import { runtimeAdapters, validateAgentProfile } from "../runs/index.js";
type ConversationDependencies = {
  repository: ConversationRepository;
  bindings: Pick<ProjectBindingService, "get">;
  models: Pick<UserModelProfilesService, "validateSelection">;
  remotes: Pick<RemoteConnectionService, "getEnvironment">;
  runnerConnections: Pick<RunnerConnections, "isOnline">;
  runnerReader: Pick<RunnerReader, "readWorkspace">;
};
export class ConversationService {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly transaction: ServiceTransaction<ConversationDependencies>,
    private readonly executionEnabled = true,
  ) {}
  async create(input: CreateConversationInput, owner: string, key?: string) {
    return this.transaction(async ({ repository, bindings, models, remotes }) => {
      const configuration = configurationSchema.parse(input.configuration ?? {});
      validateAgentProfile(configuration, input.mode, Boolean(input.goal));
      await this.validateConfiguration(configuration, owner, models, remotes);
      const binding = input.mode === "project" && input.projectId ? await bindings.get(input.projectId, owner) : null;
      if (input.mode === "project" && !binding)
        throw new DomainError("CONFLICT", "Bind a Runner before creating a project conversation", {
          reason: "RUNNER_BINDING_REQUIRED",
        });
      if (input.initialInput)
        await this.validateBlocks(input.initialInput.blocks, configuration, binding, owner, remotes);
      return toDTO(
        await repository.create({
          ownerUserId: owner,
          mode: input.mode,
          projectId: input.projectId ?? null,
          title:
            input.title ??
            input.initialInput?.blocks
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join(" ")
              .slice(0, 60) ??
            null,
          metadata: {
            binding,
            configuration,
            goal: input.goal ? { ...input.goal, status: "ready", revision: 1, iterations: 0 } : null,
          },
          ...(input.initialInput ? { initialInput: input.initialInput } : {}),
          ...(key ? { idempotencyKey: key } : {}),
        }),
      );
    });
  }
  async list(input: { ownerUserId: string; limit: number }) {
    return (await this.conversations.list(input)).map(toDTO);
  }
  async snapshot(id: string, owner: string) {
    return this.transaction(
      async ({ repository }) => {
        const snapshot = await repository.snapshot(id, owner);
        if (!this.executionEnabled)
          snapshot.capabilities = {
            tools: false,
            approval: false,
            question: false,
            steering: false,
            resume: false,
            compact: false,
            images: false,
            files: false,
          };
        return conversationSnapshotSchema.parse(snapshot);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
  messages(id: string, owner: string, before?: string) {
    return this.conversations.messages(id, owner, before);
  }
  async appendPendingInput(input: Parameters<ConversationRepository["enqueue"]>[0]) {
    return this.transaction(async ({ repository, bindings, models, remotes }) => {
      const conversation = await repository.findById({
        id: input.conversationId,
        ownerUserId: input.ownerUserId,
      });
      if (!conversation) throw new DomainError("NOT_FOUND", "Conversation not found");
      const configuration = input.configuration ?? configurationSchema.parse(conversation.metadata.configuration ?? {});
      validateAgentProfile(configuration, conversation.mode, Boolean(input.goal || conversation.metadata.goal));
      if (input.mode === "steer" && !runtimeAdapters.get(configuration.backendId)?.capabilities.steering)
        throw new DomainError("CONFLICT", "Steering is not supported by this backend");
      await this.validateConfiguration(configuration, input.ownerUserId, models, remotes);
      await this.validateBlocks(
        input.blocks,
        configuration,
        conversation.metadata.binding ?? null,
        input.ownerUserId,
        remotes,
      );
      return repository.enqueue(input);
    });
  }
  updateGoal(id: string, owner: string, action: "pause" | "resume" | "complete" | "remove", revision: number) {
    return this.transaction(async ({ repository }) => {
      return repository.updateGoal(id, owner, action, revision);
    });
  }
  /**
   * 直接切换本会话绑定的 Runner：仅当原绑定设备离线时允许（在线以实时连接注册表为准）。
   * 目标设备必须已注册且上报过工作目录；目录与指令保持会话原值。
   */
  async updateBinding(id: string, owner: string, runnerId: string) {
    return this.transaction(async ({ repository, runnerConnections, runnerReader }) => {
      const conversation = await repository.findById({ id, ownerUserId: owner });
      const current = conversation?.mode === "project" ? conversation.metadata.binding : null;
      if (!conversation || !current?.runnerId)
        throw new DomainError("CONFLICT", "Only conversations bound to a Runner can switch it", {
          reason: "RUNNER_BINDING_REQUIRED",
        });
      if (current.runnerId === runnerId)
        return repository.updateBinding(id, owner, {
          runnerId,
          workspaceId: current.workspaceId,
        });
      if (runnerConnections.isOnline(current.runnerId, owner))
        throw new DomainError("CONFLICT", "The bound Runner is online; switch only offline devices", {
          reason: "RUNNER_ONLINE",
        });
      const target = await runnerReader.readWorkspace({ id: runnerId, ownerUserId: owner });
      if (!target) throw new DomainError("NOT_FOUND", "Runner not found");
      if (!target.workspaceId)
        throw new DomainError("CONFLICT", "Target Runner has not reported a workspace", {
          reason: "WORKSPACE_MISSING",
        });
      return repository.updateBinding(id, owner, { runnerId, workspaceId: target.workspaceId });
    });
  }
  private async validateConfiguration(
    configuration: Configuration,
    owner: string,
    models: ConversationDependencies["models"],
    remotes: ConversationDependencies["remotes"],
  ) {
    if (!runtimeAdapters.has(configuration.backendId))
      throw new DomainError("VALIDATION_ERROR", "Backend is not registered");
    await models.validateSelection(configuration.modelId, owner, configuration.reasoningEffort ?? null);
    if (configuration.remoteConnectionId) await remotes.getEnvironment(configuration.remoteConnectionId, owner);
  }
  private async validateBlocks(
    blocks: InputBlock[],
    configuration: Configuration,
    binding: Awaited<ReturnType<ProjectBindingService["get"]>>,
    owner: string,
    remotes: ConversationDependencies["remotes"],
  ) {
    for (const block of blocks)
      if (block.type !== "text") {
        const capability = runtimeAdapters.get(configuration.backendId)?.capabilities;
        if (block.type === "image" ? !capability?.images : !capability?.files)
          throw new DomainError("CONFLICT", "This content type is not enabled");
        const { ref } = block.attachment;
        if (ref.kind === "object") {
          if (
            block.type !== "image" ||
            !ref.key.startsWith(`uploads/${encodeURIComponent(owner)}/`) ||
            !block.attachment.sha256 ||
            !block.attachment.mimeType.startsWith("image/")
          )
            throw new DomainError("FORBIDDEN", "Attachment does not belong to this user");
          continue;
        }
        if (ref.kind === "runner" && (ref.runnerId !== binding?.runnerId || ref.workspaceId !== binding?.workspaceId))
          throw new DomainError("FORBIDDEN", "Attachment belongs to another Runner");
        if (ref.kind === "ssh") {
          if (ref.remoteConnectionId !== (binding?.remoteConnectionId ?? configuration.remoteConnectionId))
            throw new DomainError("FORBIDDEN", "Attachment belongs to another environment");
          await remotes.getEnvironment(ref.remoteConnectionId, owner);
        }
        if (!block.attachment.sha256) throw new DomainError("VALIDATION_ERROR", "Select a verified workspace file");
      }
  }
  removePendingInput(input: Parameters<ConversationRepository["removePendingInput"]>[0]) {
    return this.transaction(async ({ repository }) => {
      return repository.removePendingInput(input);
    });
  }
  steerPendingInput(input: Parameters<ConversationRepository["steerPendingInput"]>[0]) {
    return this.transaction(async ({ repository }) => {
      return repository.steerPendingInput(input);
    });
  }
  async rename(id: string, owner: string, title: string) {
    return toDTO(await this.conversations.update(id, owner, title));
  }
  maintain(id: string, owner: string, action: "clear" | "delete") {
    return this.transaction(async ({ repository }) => {
      return repository.maintain(id, owner, action);
    });
  }
}
function toDTO(row: ConversationRow) {
  return {
    ...conversationView(row),
    activeRunId: row.activeRunId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
