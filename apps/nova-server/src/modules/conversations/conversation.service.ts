import { configurationSchema, type Attachment, type InputBlock, type Configuration, type Message } from "@nova/agent-ui-contracts";
import { DomainError } from "../../shared/domain-error.js";
import { disabledUploadStorage, type UploadStorage } from "../attachments/upload-storage.js";
import type { ProjectBindingService } from "../projects/index.js";
import type { RunnerConnections, RunnerReader } from "../runners/index.js";
import type { ConversationRow, ConversationRepository } from "./conversation.repository.js";
import type { ServiceTransaction } from "../../shared/scope.js";
import type { UserModelProfilesService } from "../model-config/index.js";
import type { RemoteConnectionService } from "../remotes/index.js";
import type { SkillService, AgentProfileReference } from "../skills/index.js";
import type { PinnedExecution } from "../runs/index.js";
import { conversationSnapshotSchema, type CreateConversationInput } from "./conversation.schema.js";
import { conversationView } from "../runs/index.js";
import { runtimeAdapters, validateAgentProfile } from "../runs/index.js";
import type { ArtifactService } from "../artifacts/index.js";
type ConversationDependencies = {
  repository: ConversationRepository;
  bindings: Pick<ProjectBindingService, "get">;
  models: Pick<UserModelProfilesService, "validateSelection">;
  remotes: Pick<RemoteConnectionService, "getEnvironment">;
  runnerConnections: Pick<RunnerConnections, "isOnline">;
  runnerReader: Pick<RunnerReader, "readWorkspace">;
  skills: SkillService;
};
export class ConversationService {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly transaction: ServiceTransaction<ConversationDependencies>,
    private readonly executionEnabled = true,
    /** 产物摘要进入会话读模型（P1-A1）；未接存储时省略该字段。 */
    private readonly artifacts?: Pick<ArtifactService, "list">,
    private readonly uploads: UploadStorage = disabledUploadStorage(),
  ) {}
  async create(input: CreateConversationInput, owner: string, key?: string) {
    return this.transaction(async ({ repository, bindings, models, remotes, skills }) => {
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
      // 技能与 Agent 内容在入队事务内按已登记版本固定；不重读磁盘或“最新”。
      const pinned = await this.pinExecution(skills, {
        ownerUserId: owner,
        configuration,
        binding,
        projectId: input.projectId ?? null,
        specSession: false,
        skill: input.initialInput?.skill,
      });
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
          pinned,
        }),
      );
    });
  }
  async list(input: { ownerUserId: string; limit: number }) {
    return (await this.conversations.list(input)).map(toDTO);
  }
  async snapshot(id: string, owner: string) {
    const snapshot = await this.transaction(
      async ({ repository }) => {
        const next = await repository.snapshot(id, owner);
        if (!this.executionEnabled)
          next.capabilities = {
            tools: false,
            approval: false,
            question: false,
            steering: false,
            resume: false,
            compact: false,
            images: false,
            files: false,
          };
        return conversationSnapshotSchema.parse(next);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    snapshot.messages = await Promise.all(snapshot.messages.map((message) => this.publicMessage(message, owner)));
    snapshot.pendingInputs = await Promise.all(
      snapshot.pendingInputs.map(async (pending) => ({
        ...pending,
        input: { ...pending.input, blocks: await this.publicInputBlocks(pending.input.blocks, owner) },
      })),
    );
    // 产物摘要进入会话读模型（P1-A1）：快照级最新状态；实时顺序仍以 artifact.changed 事件 + 列表接口为准。
    if (this.artifacts) snapshot.artifacts = (await this.artifacts.list({ conversationId: id, ownerUserId: owner, limit: 50 })).items;
    return snapshot;
  }
  async messages(id: string, owner: string, before?: string) {
    const page = await this.conversations.messages(id, owner, before);
    return { ...page, items: await Promise.all(page.items.map((message) => this.publicMessage(message, owner))) };
  }
  async appendPendingInput(input: Parameters<ConversationRepository["enqueue"]>[0]) {
    return this.transaction(async ({ repository, bindings, models, remotes, skills }) => {
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
      const pinned = await this.pinExecution(skills, {
        ownerUserId: input.ownerUserId,
        configuration,
        binding: conversation.metadata.binding ?? null,
        projectId: conversation.projectId,
        specSession: Boolean(conversation.metadata.specId),
        skill: input.skill,
      });
      return repository.enqueue(input, pinned);
    });
  }
  /**
   * 入队前固定技能/Agent 引用（docs/design/nova-skills.md §6）。校验归属、项目范围、版本、模式与工具，
   * 并把已发布版本的完整内容返回给上层写入 `pending_inputs.payload.execution`。
   */
  private async pinExecution(
    skills: SkillService,
    input: {
      ownerUserId: string;
      configuration: Configuration;
      binding: { runnerId: string | null; workspaceId: string; canonicalCwd: string } | null | undefined;
      projectId: string | null;
      specSession: boolean;
      skill?: { id: string; version: string } | undefined;
    },
  ): Promise<PinnedExecution> {
    const environment = skills.conversationEnvironment({
      ownerUserId: input.ownerUserId,
      specSession: input.specSession,
      projectId: input.projectId,
      configuration: input.configuration,
      binding: input.binding
        ? { runnerId: input.binding.runnerId, workspaceId: input.binding.workspaceId, canonicalCwd: input.binding.canonicalCwd }
        : null,
    });
    const pinned: PinnedExecution = {};
    const profile = input.configuration.agentProfile;
    if (profile && "source" in profile) {
      if (profile.source === "platform")
        throw new DomainError("VALIDATION_ERROR", "Platform agent profiles are not available yet");
      const reference: AgentProfileReference = { source: profile.source, refId: profile.refId, version: profile.version };
      pinned.agent = await skills.pinAgent(reference, environment);
    }
    if (input.skill) pinned.skill = await skills.pinForQueueing(input.skill, environment);
    return pinned;
  }
  updateGoal(id: string, owner: string, action: "pause" | "resume" | "complete" | "remove", revision: number) {
    return this.transaction(async ({ repository }) => {
      return repository.updateGoal(id, owner, action, revision);
    });
  }
  updateExecutionMode(id: string, owner: string, mode: Configuration["mode"]) {
    return this.transaction(async ({ repository }) => repository.updateExecutionMode(id, owner, mode));
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
        if (ref.kind === "image") {
          if (block.type !== "image" || !block.attachment.sha256 || !block.attachment.mimeType.startsWith("image/"))
            throw new DomainError("VALIDATION_ERROR", "Select a verified image attachment");
          await this.uploads.resolveImageUrl(owner, ref.url);
          continue;
        }
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
  private async publicAttachment(attachment: Attachment, owner: string): Promise<Attachment> {
    const ref = attachment.ref;
    if (ref.kind === "image") {
      const signed = await this.uploads.resolveImageUrl(owner, ref.url);
      return { ...attachment, ref: { kind: "image", url: signed.url } };
    }
    if (ref.kind === "object") {
      const signed = await this.uploads.imageUrl(owner, ref);
      return { ...attachment, ref: { kind: "image", url: signed.url } };
    }
    return attachment;
  }
  private async publicMessage(message: Message, owner: string): Promise<Message> {
    const blocks = await Promise.all(
      message.blocks.map(async (block) => {
        if (block.type !== "image") return block;
        return { ...block, attachment: await this.publicAttachment(block.attachment, owner) };
      }),
    );
    return { ...message, blocks };
  }
  private async publicInputBlocks(blocks: InputBlock[], owner: string): Promise<InputBlock[]> {
    return Promise.all(
      blocks.map(async (block) => {
        if (block.type !== "image") return block;
        return { ...block, attachment: await this.publicAttachment(block.attachment, owner) };
      }),
    );
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
