import { and, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { createScope, defineRepository } from "../../shared/scope.js";
import type { ArtifactState, PublicError } from "@nova/agent-ui-contracts";
import { runArtifacts, type Database } from "../../../database/index.js";

/**
 * 产物索引数据访问（P1-B1/C1，docs/nova-skills.md §7–§8.1）。
 * 只碰 run_artifacts；Run→会话→用户 的归属校验经 runs 注入的 settlement 端口，
 * 这里不查询外域表（domain-boundaries）。
 */

export type ArtifactRow = typeof runArtifacts.$inferSelect;
export type ArtifactQuota = { files: number; bytes: number };

export const artifactRepository = defineRepository(({ db, requireTransaction }) => ({
  /**
   * 稳定发布键 (runId, toolExecutionId)：为相同工具执行重放返回原记录，不新建产物。
   * 插入即额度预留（publishing 行计入 quota），失败结算时释放。
   */
  async reserve(input: { runId: string; toolExecutionId: string; name: string; skillVersionId: string | null }) {
    requireTransaction();
    const [created] = await db
      .insert(runArtifacts)
      // 预留行先占位 mime，冻结字节后由 recordFacts 落真实类型（§7 步骤 4）。
      .values({ ...input, mimeType: "application/octet-stream" })
      .onConflictDoNothing()
      .returning();
    if (created) return { row: created, created: true as const };
    const [existing] = await db
      .select()
      .from(runArtifacts)
      .where(and(eq(runArtifacts.runId, input.runId), eq(runArtifacts.toolExecutionId, input.toolExecutionId)));
    if (!existing) throw new Error("Artifact reservation lost");
    return { row: existing, created: false as const };
  },
  async find(artifactId: string) {
    const [row] = await db.select().from(runArtifacts).where(eq(runArtifacts.id, artifactId));
    return row;
  },
  async findByPublishKey(runId: string, toolExecutionId: string) {
    const [row] = await db
      .select()
      .from(runArtifacts)
      .where(and(eq(runArtifacts.runId, runId), eq(runArtifacts.toolExecutionId, toolExecutionId)));
    return row;
  },
  async quotaForRun(runId: string): Promise<ArtifactQuota> {
    // 额度只统计未释放的发布（publishing 预留 + ready 成品）；failed 不占额度。
    const [row] = await db
      .select({
        files: sql<number>`count(*)::int`,
        bytes: sql<string>`coalesce(sum(${runArtifacts.size}), 0)`,
      })
      .from(runArtifacts)
      .where(and(eq(runArtifacts.runId, runId), inArray(runArtifacts.state, ["publishing", "ready"])));
    return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
  },
  /** 冻结字节后、上传前：先持久化摘要/大小/对象键（§7 步骤 4）。 */
  async recordFacts(
    artifactId: string,
    facts: { sha256: string; size: number; objectKey: string; mimeType: string; preview: ArtifactRow["preview"]; recovery: Record<string, unknown> },
  ) {
    requireTransaction();
    await db
      .update(runArtifacts)
      .set({ ...facts, updatedAt: new Date() })
      .where(and(eq(runArtifacts.id, artifactId), eq(runArtifacts.state, "publishing")));
  },
  async markReady(artifactId: string, recovery: Record<string, unknown>) {
    requireTransaction();
    const [row] = await db
      .update(runArtifacts)
      .set({ state: "ready", recovery, updatedAt: new Date() })
      .where(and(eq(runArtifacts.id, artifactId), inArray(runArtifacts.state, ["publishing", "failed"])))
      .returning();
    return row;
  },
  async markFailed(artifactId: string, error: PublicError, recovery: Record<string, unknown>, facts?: { sha256: string; size: number; mimeType: string }) {
    requireTransaction();
    const [row] = await db
      .update(runArtifacts)
      .set({ state: "failed", error, recovery, ...(facts ? { sha256: facts.sha256, size: facts.size, mimeType: facts.mimeType } : {}), updatedAt: new Date() })
      .where(and(eq(runArtifacts.id, artifactId), eq(runArtifacts.state, "publishing")))
      .returning();
    return row;
  },
  /** 恢复元数据更新（待核实标记等），不改发布状态。 */
  async patchRecovery(artifactId: string, recovery: Record<string, unknown>) {
    requireTransaction();
    await db
      .update(runArtifacts)
      .set({ recovery, updatedAt: new Date() })
      .where(eq(runArtifacts.id, artifactId));
  },
  async countReadyForRun(runId: string) {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(runArtifacts)
      .where(and(eq(runArtifacts.runId, runId), eq(runArtifacts.state, "ready")));
    return Number(row?.total ?? 0);
  },
  /** 未结算发布数（publishing）：tmp 清理必须等全部发布结算之后（§7 清理段）。 */
  async countPendingForRun(runId: string) {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(runArtifacts)
      .where(and(eq(runArtifacts.runId, runId), eq(runArtifacts.state, "publishing")));
    return Number(row?.total ?? 0);
  },
  /** 游标 = `createdAt|id`（specs 同型态）；按会话（经 settlement 端口解出的 runIds）分页列摘要。 */
  async listForRuns(runIds: readonly string[], filters: { limit: number; cursor?: { createdAt: Date; id: string } }) {
    if (runIds.length === 0) return [];
    return db
      .select()
      .from(runArtifacts)
      .where(
        and(
          inArray(runArtifacts.runId, [...runIds]),
          filters.cursor
            ? or(
                lt(runArtifacts.createdAt, filters.cursor.createdAt),
                and(eq(runArtifacts.createdAt, filters.cursor.createdAt), lt(runArtifacts.id, filters.cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(runArtifacts.createdAt), desc(runArtifacts.id))
      .limit(filters.limit + 1);
  },
  /** 清理 Job 用：一批 Run 的待删对象键（P1-F1；会话删除时在同一事务内取键并入队）。 */
  async objectKeysForRuns(runIds: readonly string[]) {
    if (runIds.length === 0) return [];
    return db
      .select({ key: runArtifacts.objectKey })
      .from(runArtifacts)
      .where(and(inArray(runArtifacts.runId, [...runIds]), sql`${runArtifacts.objectKey} is not null`));
  },
  /** 孤儿扫描的保护集：数据库仍引用的全部对象键（任何状态；publishing/预留另行按更新时间保护）。 */
  async referencedObjectKeys() {
    return db.select({ key: runArtifacts.objectKey }).from(runArtifacts).where(sql`${runArtifacts.objectKey} is not null`);
  },
  /** 孤儿扫描保护集：仍在 publishing 的对象键（P1-F1）。 */
  async protectedObjectKeys(updatedBefore: Date) {
    return db
      .select({ key: runArtifacts.objectKey, updatedAt: runArtifacts.updatedAt })
      .from(runArtifacts)
      .where(and(eq(runArtifacts.state, "publishing"), sql`${runArtifacts.objectKey} is not null`, gt(runArtifacts.updatedAt, updatedBefore)));
  },
}));
export function createArtifactRepository(db: Database) {
  return createScope(db).get(artifactRepository);
}
export type ArtifactRepository = ReturnType<typeof createArtifactRepository>;
