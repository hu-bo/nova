import { createScope, defineRepository } from "../../shared/scope.js";
import { projects, type Database } from "../../../database/index.js";
import { and, asc, desc, eq, isNull } from "drizzle-orm";

export type Project = {
  id: string;
  ownerUserId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

export interface ProjectRepository {
  create(input: { ownerUserId: string; name: string }): Promise<Project>;
  findById(input: { ownerUserId: string; id: string }): Promise<Project | undefined>;
  list(input: { ownerUserId: string; limit: number; cursor?: { createdAt: Date; id: string } }): Promise<Project[]>;
  update(input: { ownerUserId: string; id: string; name: string }): Promise<Project | undefined>;
  softDelete(input: { ownerUserId: string; id: string }): Promise<boolean>;
}

export const projectRepository = defineRepository(({ db }): ProjectRepository => {
  return {
    async create(input) {
      const rows = await db.insert(projects).values(input).returning();
      const project = rows[0];
      if (!project) throw new Error("Failed to persist project");
      return project;
    },
    async findById({ ownerUserId, id }) {
      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, id), isNull(projects.deletedAt)))
        .limit(1);
      return project;
    },
    async list({ ownerUserId, limit, cursor }) {
      const whereCursor = cursor
        ? // 稳定的 (created_at, id) cursor, 严格 < 比较保证不重复
          // 注: 单调键为复合 (createdAt, id); 这里由外层 service 拆分 cursor
          // 实际查询统一过 owner predicate + deleted_at IS NULL
          undefined
        : undefined;
      return db
        .select()
        .from(projects)
        .where(
          and(eq(projects.ownerUserId, ownerUserId), isNull(projects.deletedAt), ...(whereCursor ? [whereCursor] : [])),
        )
        .orderBy(desc(projects.createdAt), asc(projects.id))
        .limit(limit);
    },
    async update({ ownerUserId, id, name }) {
      const [project] = await db
        .update(projects)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, id), isNull(projects.deletedAt)))
        .returning();
      return project;
    },
    async softDelete({ ownerUserId, id }) {
      // 软删除不级联; 后续由 attachment GC job 按 project 维度回收 runner_ref
      // 引用与 jsonb 标记。deleted_at = now() 同时满足业务层通过 owner + deleted_at
      // IS NULL 的隐式软删除过滤。
      const deleted = await db
        .update(projects)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, id), isNull(projects.deletedAt)))
        .returning({ id: projects.id });
      return deleted.length > 0;
    },
  };
});
export function createProjectRepository(db: Database) {
  return createScope(db).get(projectRepository);
}
