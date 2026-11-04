import { posix } from "node:path";
import { DomainError } from "../../shared/domain-error.js";
import type { ServiceTransaction } from "../../shared/scope.js";
import type { RemoteConnectionService } from "../remotes/index.js";
import type { RunnerReader } from "../runners/index.js";
import type { ProjectBindingRepository } from "./project-binding.repository.js";
import { bindingSchema, type BindProjectInput } from "./project-binding.schema.js";

export class ProjectBindingService {
  constructor(
    private readonly repository: ProjectBindingRepository,
    private readonly transaction: ServiceTransaction<{
      repository: ProjectBindingRepository;
      runners: RunnerReader;
      remotes?: Pick<RemoteConnectionService, "getEnvironment">;
    }>,
  ) {}

  async get(id: string, ownerUserId: string) {
    const project = await this.repository.findProject(id, ownerUserId);
    if (!project) throw new DomainError("NOT_FOUND", "Project not found");
    const binding = await this.repository.current(id);
    return binding ? bindingSchema.parse(binding) : null;
  }

  async bind(id: string, ownerUserId: string, input: BindProjectInput) {
    const path = input.canonicalCwd.replace(/\\/g, "/");
    if (
      /[\x00-\x1f]/.test(path) ||
      /^[a-z]:/i.test(path) ||
      path.split("/").includes("..") ||
      (!input.remoteConnectionId && (path.startsWith("/") || path.split("/").includes("")))
    ) {
      throw new DomainError("VALIDATION_ERROR", "Invalid workspace path", { field: "canonicalCwd" });
    }
    return this.transaction(async ({ repository, runners, remotes }) => {
      const remote = input.remoteConnectionId
        ? await remotes?.getEnvironment(input.remoteConnectionId, ownerUserId)
        : null;
      if (input.remoteConnectionId && !remote) throw new DomainError("CONFLICT", "SSH environment unavailable");
      const workspaceId = remote?.workspaceId ?? input.workspaceId!;
      // Lock the project to serialize revisions, including the first binding.
      const project = await repository.lockProject(id, ownerUserId);
      if (!project) throw new DomainError("NOT_FOUND", "Project not found");
      const runner = input.runnerId ? await runners.readWorkspace({ id: input.runnerId, ownerUserId }) : undefined;
      if (input.runnerId && (!runner || runner.workspaceId !== workspaceId))
        throw new DomainError("CONFLICT", "Runner workspace changed", { reason: "WORKSPACE_CHANGED" });
      const current = await repository.current(id);
      if ((current?.revision ?? 0) !== input.expectedRevision)
        throw new DomainError("CONFLICT", "Binding changed", { reason: "REVISION_CONFLICT" });
      await repository.invalidate(id);
      const binding = await repository.insert({
        projectId: id,
        revision: input.expectedRevision + 1,
        runnerId: input.runnerId ?? null,
        remoteConnectionId: input.remoteConnectionId ?? null,
        workspaceId,
        canonicalCwd: remote ? posix.normalize(path) : path,
        instructions: {
          source: input.instructionSource ?? (input.customPrompt ? "custom" : "none"),
          customPrompt: !input.instructionSource || input.instructionSource === "custom" ? input.customPrompt : "",
        },
      });
      await repository.touchProject(id);
      return bindingSchema.parse(binding);
    });
  }
}
