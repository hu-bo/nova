import { createScope, defineRepository } from "../../shared/scope.js";
import { enqueue } from "../../jobs/postgres-job-store.js";
import type { Database } from "../../../database/index.js";
import { artifactRepository } from "./artifact.repository.js";

/**
 * 产物清理调度（docs/nova-skills.md §7 清理段，P1-F1）。
 * 删除会话时由 conversations 域在既有删除 Run 的事务中调用本端口：
 * 级联删行前收集对象键并写入对象删除 Job（事务外由 worker handler 删对象）。
 * 项目删除沿会话清理路径进行；停用技能不删除历史产物（本端口只挂在会话删除上）。
 */
export const artifactCleanup = defineRepository(
  { artifacts: artifactRepository },
  ({ db, requireTransaction, artifacts }) => ({
    async schedulePurgeForRuns(runIds: readonly string[], conversationId: string): Promise<void> {
      requireTransaction();
      if (runIds.length === 0) return;
      const rows = await artifacts.objectKeysForRuns(runIds);
      const keys = rows.map((row) => row.key).filter((key): key is string => Boolean(key));
      if (keys.length === 0) return;
      await enqueue({
        db,
        job: {
          kind: "artifact.purge",
          aggregateId: runIds[0]!,
          dedupeKey: conversationId,
          payload: { conversationId, keys },
        },
      });
    },
  }),
);
export function createArtifactCleanup(db: Database) {
  return createScope(db).get(artifactCleanup);
}
export type ArtifactCleanup = ReturnType<typeof createArtifactCleanup>;
