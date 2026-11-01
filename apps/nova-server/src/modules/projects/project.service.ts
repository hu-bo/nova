import { DomainError } from "../../shared/domain-error.js";
import type { CreateProjectInput, UpdateProjectInput } from "./project.schema.js";
import type { Project, ProjectRepository } from "./project.repository.js";

export class ProjectService {
  constructor(private readonly repository: ProjectRepository) {}

  /**
   * 创建项目: 始终把 ownerUserId 设置为当前 principal 的 local user id, 客户端
   * 传入的 owner 字段不会被采纳(见 docs/nova-server.md §10.1)。
   */
  create(input: CreateProjectInput, ownerUserId: string): Promise<Project> {
    return this.repository.create({ ownerUserId, name: input.name });
  }

  async get(id: string, ownerUserId: string): Promise<Project> {
    const project = await this.repository.findById({ ownerUserId, id });
    if (!project) throw new DomainError("NOT_FOUND", "Project not found");
    return project;
  }

  list(input: { ownerUserId: string; limit: number }): Promise<Project[]> {
    return this.repository.list({ ownerUserId: input.ownerUserId, limit: input.limit });
  }

  async update(id: string, input: UpdateProjectInput, ownerUserId: string): Promise<Project> {
    // 后续 patch /api/projects/:id 接受 expectedRevision; 在此之前要求 name 必填,
    // 让 schema 体现 v1 contract 的最小行为。
    if (input.name === undefined) {
      throw new DomainError("VALIDATION_ERROR", "name is required");
    }
    const project = await this.repository.update({ ownerUserId, id, name: input.name });
    if (!project) throw new DomainError("NOT_FOUND", "Project not found");
    return project;
  }

  async delete(id: string, ownerUserId: string): Promise<void> {
    // 软删除: tombstone 后由附属 GC job 回收附件引用。
    if (!(await this.repository.softDelete({ ownerUserId, id })))
      throw new DomainError("NOT_FOUND", "Project not found");
  }
}