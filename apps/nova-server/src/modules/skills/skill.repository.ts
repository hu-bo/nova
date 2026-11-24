import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { createScope, defineRepository } from "../../shared/scope.js";
import { skills, skillVersions, type Database } from "../../../database/index.js";
import type { SkillExecutionRequirements, SkillSource } from "@nova/agent-ui-contracts";

/** 项目范围过滤：undefined=不过滤，null=仅个人技能（无项目归属），否则限定项目。 */
function projectScopeFilter(projectId?: string | null) {
  if (projectId === undefined) return undefined;
  if (projectId === null) return isNull(skills.projectId);
  return eq(skills.projectId, projectId);
}

/**
 * Skills 数据访问（docs/nova-skills.md §8.1）。SQL 全部留在本层；
 * 版本行不可变：没有 UPDATE/DELETE skill_versions 正文的入口（红线 4、§6）。
 */
export const skillRepository = defineRepository(({ db }) => ({
  async findRowById(id: string) {
    const [row] = await db.select().from(skills).where(eq(skills.id, id));
    return row;
  },
  async findOwnedRow(id: string, ownerUserId: string) {
    const [row] = await db
      .select()
      .from(skills)
      .where(and(eq(skills.id, id), eq(skills.ownerUserId, ownerUserId)));
    return row;
  },
  async findBuiltinBySlug(slug: string) {
    const [row] = await db
      .select()
      .from(skills)
      .where(and(eq(skills.source, "builtin"), eq(skills.slug, slug)));
    return row;
  },
  async listBuiltins() {
    return db.select().from(skills).where(eq(skills.source, "builtin")).orderBy(asc(skills.slug));
  },
  /** 平台目录：当前用户所有 platform 技能；可按项目过滤（projectId=null 表示个人技能）。 */
  async listPlatform(ownerUserId: string, filters: { projectId?: string | null; q?: string; limit: number; cursor?: { updatedAt: Date; id: string } }) {
    const projectFilter = projectScopeFilter(filters.projectId);
    const where = and(
      eq(skills.source, "platform"),
      eq(skills.ownerUserId, ownerUserId),
      projectFilter,
      filters.q
        ? sql`(${ilike(skills.slug, `%${filters.q}%`)} or ${ilike(skills.description, `%${filters.q}%`)})`
        : undefined,
      filters.cursor
        ? or(
            lt(skills.updatedAt, filters.cursor.updatedAt),
            and(eq(skills.updatedAt, filters.cursor.updatedAt), lt(skills.id, filters.cursor.id)),
          )
        : undefined,
    );
    return db
      .select()
      .from(skills)
      .where(where)
      .orderBy(desc(skills.updatedAt), desc(skills.id))
      .limit(filters.limit + 1);
  },
  /** 本地来源索引：按 (owner, runnerId, scope 定位列, slug) 查询/创建。 */
  async findLocalIdentity(input: {
    ownerUserId: string;
    runnerId: string;
    source: Extract<SkillSource, "runner-global" | "runner-project">;
    workspaceId: string | null;
    relativeCwd: string | null;
    slug: string;
  }) {
    const [row] = await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.ownerUserId, input.ownerUserId),
          eq(skills.source, input.source),
          eq(skills.runnerId, input.runnerId),
          input.workspaceId === null ? isNull(skills.workspaceId) : eq(skills.workspaceId, input.workspaceId),
          input.relativeCwd === null ? isNull(skills.relativeCwd) : eq(skills.relativeCwd, input.relativeCwd),
          eq(skills.slug, input.slug),
        ),
      );
    return row;
  },
  async insertLocalIdentity(input: {
    ownerUserId: string;
    runnerId: string;
    source: Extract<SkillSource, "runner-global" | "runner-project">;
    workspaceId: string | null;
    relativeCwd: string | null;
    slug: string;
    description: string;
  }) {
    const locator = {
      ownerUserId: input.ownerUserId,
      runnerId: input.runnerId,
      source: input.source,
      workspaceId: input.workspaceId,
      relativeCwd: input.relativeCwd,
      slug: input.slug,
    };
    const [row] = await db
      .insert(skills)
      .values({ ...input, draftBody: null, draftRequirements: null })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const existing = await this.findLocalIdentity(locator);
    if (!existing) throw new Error("Local skill identity registration failed");
    // 目录刷新时同步展示元数据（来源索引描述以磁盘 frontmatter 为准）。
    if (existing.description !== input.description) {
      const [updated] = await db
        .update(skills)
        .set({ description: input.description, updatedAt: new Date() })
        .where(eq(skills.id, existing.id))
        .returning();
      return updated ?? existing;
    }
    return existing;
  },
  /** 目录合并用：一个 Runner 上全部本地来源索引（global + project），读取路径不写库。 */
  async listAllLocalByRunner(ownerUserId: string, runnerRowId: string) {
    return db
      .select()
      .from(skills)
      .where(and(eq(skills.ownerUserId, ownerUserId), eq(skills.runnerId, runnerRowId)));
  },
  async listLocalByProject(input: { ownerUserId: string; runnerRowId: string; workspaceId: string; relativeCwd: string }) {
    return db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.ownerUserId, input.ownerUserId),
          eq(skills.source, "runner-project"),
          eq(skills.runnerId, input.runnerRowId),
          eq(skills.workspaceId, input.workspaceId),
          eq(skills.relativeCwd, input.relativeCwd),
        ),
      );
  },
  async insertPlatformSkill(input: {
    ownerUserId: string;
    projectId: string | null;
    slug: string;
    displayName: string | null;
    description: string;
    draftBody: string;
    draftRequirements: SkillExecutionRequirements;
  }) {
    const [row] = await db
      .insert(skills)
      .values({ source: "platform", ...input })
      .returning();
    if (!row) throw new Error("Skill draft creation failed");
    return row;
  },
  /** 内置登记行（source=builtin，无所有者）；slug 唯一索引由并发兜底使用。 */
  async insertBuiltinSkill(input: { slug: string; displayName: string | null; description: string }) {
    const [row] = await db
      .insert(skills)
      .values({ source: "builtin", ownerUserId: null, slug: input.slug, displayName: input.displayName, description: input.description })
      .returning();
    if (!row) throw new Error("Builtin skill registration failed");
    return row;
  },
  /** 草稿保存携带 expectedRevision 防并发覆盖（§8.2）；返回 undefined 表示 revision 不符或不可见。 */
  async updateDraft(
    skillId: string,
    ownerUserId: string,
    expectedRevision: number,
    patch: { draftBody: string; slug: string; description: string; requirements: SkillExecutionRequirements },
  ) {
    const [row] = await db
      .update(skills)
      .set({
        draftBody: patch.draftBody,
        slug: patch.slug,
        description: patch.description,
        draftRequirements: patch.requirements,
        draftRevision: sql`${skills.draftRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(skills.id, skillId), eq(skills.ownerUserId, ownerUserId), eq(skills.draftRevision, expectedRevision)))
      .returning();
    return row;
  },
  async disableSkill(skillId: string, ownerUserId: string) {
    const [row] = await db
      .update(skills)
      .set({ disabled: true, updatedAt: new Date() })
      .where(and(eq(skills.id, skillId), eq(skills.ownerUserId, ownerUserId)))
      .returning();
    return row;
  },
  async setCurrentPublishedVersion(skillId: string, versionId: string) {
    await db
      .update(skills)
      .set({ currentPublishedVersionId: versionId, updatedAt: new Date() })
      .where(eq(skills.id, skillId));
  },

  // ---- skill_versions：不可变，只有插入与读取 ----
  async findVersion(skillId: string, version: string) {
    const [row] = await db
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)));
    return row;
  },
  async findVersionById(versionId: string) {
    const [row] = await db.select().from(skillVersions).where(eq(skillVersions.id, versionId));
    return row;
  },
  /** 同摘要复用版本行：本地快照按 (skillId, sha256) 命中已有版本（§4.3 末段）。 */
  async findVersionBySha(skillId: string, sha256: string) {
    const [row] = await db
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.sha256, sha256)))
      .limit(1);
    return row;
  },
  /** 本地磁盘摘要 → 已接受版本（快照复用与漂移判定的同一事实源）。 */
  async findVersionBySourceSha(skillId: string, sourceSha256: string) {
    const [row] = await db
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.sourceSha256, sourceSha256)))
      .limit(1);
    return row;
  },
  async countVersions(skillId: string) {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId));
    return Number(row?.total ?? 0);
  },
  async insertVersion(input: {
    skillId: string;
    version: string;
    body: string;
    slug: string;
    description: string;
    displayName: string | null;
    requirements: SkillExecutionRequirements;
    sha256: string;
    sourceSha256: string | null;
    resources: { path: string; size: number; sha256: string }[] | null;
  }) {
    const [row] = await db.insert(skillVersions).values(input).onConflictDoNothing().returning();
    if (row) return row;
    const existing = await this.findVersion(input.skillId, input.version);
    if (!existing) throw new Error("Skill version insert failed");
    return existing;
  },
  async listVersions(skillId: string, filters: { limit: number; cursor?: Date }) {
    return db
      .select()
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, skillId),
          filters.cursor ? lt(skillVersions.createdAt, filters.cursor) : undefined,
        ),
      )
      .orderBy(desc(skillVersions.createdAt), desc(skillVersions.id))
      .limit(filters.limit + 1);
  },
  /** 目录合并的批量摘要查询：按 (skillId, source_sha256) 命中本地已接受版本，避免逐条查询。 */
  async listVersionsBySourceSha(pairs: readonly { skillId: string; sourceSha256: string }[]) {
    if (pairs.length === 0) return [];
    return db
      .select()
      .from(skillVersions)
      .where(
        inArray(
          sql`(${skillVersions.skillId}, ${skillVersions.sourceSha256})`,
          pairs.map((pair) => sql`(${pair.skillId}::uuid, ${pair.sourceSha256})`),
        ),
      );
  },
}));
export function createSkillRepository(db: Database) {
  return createScope(db).get(skillRepository);
}
export type SkillRepository = ReturnType<typeof createSkillRepository>;
