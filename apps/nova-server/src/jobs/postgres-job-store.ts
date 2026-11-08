import { and, eq, getTableName, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { jobs, runs } from "../../database/index.js";
import type { Database } from "../../database/index.js";

/**
 * Durable job queue mechanics. 与 Agent / Task Engine 不重叠, 仅承载业务运行唤醒、
 * GC、外部通知 (outbox)。job-registry 把 job.kind 路由到业务 handler; handler 必须
 * 自身是 at-least-once + idempotent.
 *
 * 选型: PostgreSQL SKIP LOCKED. 短事务 claim, 提交后释放行锁, 不在事务外持有 DB 锁;
 * 与 docs/nova-server.md §8.1 一致. 实际 claim 走轮询 + LISTEN/NOTIFY (本期未接入,
 * 留作后续 worker entry 接入).
 */
export type JobKind =
  "run.wake" | "conversation.context-compact" | "conversation.context-clear" | "attachment.gc" | "outbox";

export type JobRecord = {
  jobId: string;
  kind: JobKind;
  aggregateId: string | null;
  dedupeKey: string | null;
  payload: Record<string, unknown>;
  schemaVersion: number;
  availableAt: Date;
  attempt: number;
  maxAttempts: number;
  leaseUntil: Date | null;
  status: "queued" | "running" | "succeeded" | "failed" | "dead";
  safeErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ClaimOutcome = { kind: "claimed"; jobs: readonly JobRecord[] } | { kind: "empty" };

/** 只需查询/写入端口: 既可在 scope 外以 Database 调用, 也可在事务内以仓库执行器调用. */
type JobExecutor = Pick<Database, "execute" | "select" | "insert" | "update">;

/**
 * 单次 claim 有界批, 短事务 SKIP LOCKED. 大批数据由 worker 调高 limit 与并发度.
 */
export async function claim(input: {
  db: JobExecutor;
  kinds: readonly JobKind[];
  limit: number;
  leaseSeconds: number;
}): Promise<ClaimOutcome> {
  const now = new Date();
  const lease = new Date(now.getTime() + input.leaseSeconds * 1000);
  const rows = await input.db.execute(sql`
    WITH candidates AS (
      SELECT id
      FROM jobs
      WHERE kind = ANY(${sql.param(input.kinds)}::text[])
        AND (status = 'queued' OR (status = 'running' AND lease_until <= ${now}))
        AND available_at <= ${now}
        AND (lease_until IS NULL OR lease_until <= ${now})
      ORDER BY available_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${input.limit}
    )
    UPDATE jobs j
    SET status = 'running',
        attempt = j.attempt + 1,
        lease_until = ${lease},
        updated_at = ${now}
    FROM candidates
    WHERE j.id = candidates.id
    RETURNING j.id, j.kind, j.aggregate_id, j.dedupe_key, j.payload, j.schema_version,
              j.available_at, j.attempt, j.max_attempts, j.lease_until, j.status,
              j.safe_error_code, j.created_at, j.updated_at
  `);
  if (!rows || (Array.isArray(rows) && rows.length === 0)) return { kind: "empty" };
  const claimed = mapRows(rows);
  return claimed.length ? { kind: "claimed", jobs: claimed } : { kind: "empty" };
}

export async function succeed(input: { db: JobExecutor; jobId: string }): Promise<void> {
  await input.db.update(jobs).set({ status: "succeeded", updatedAt: sql`now()` }).where(eq(jobs.id, input.jobId));
}

export async function fail(input: {
  db: JobExecutor;
  jobId: string;
  safeErrorCode: string;
  rescheduleAfterSeconds?: number;
}): Promise<void> {
  const availableAt = input.rescheduleAfterSeconds
    ? new Date(Date.now() + input.rescheduleAfterSeconds * 1000)
    : new Date(Date.now() + 30_000);
  await input.db
    .update(jobs)
    .set({
      // dead/queued 取决于行内 attempt 与 max_attempts 的比较, 留在引用类型列的 SQL 片段里.
      status: sql`case when ${jobs.attempt} >= ${jobs.maxAttempts} then 'dead' else 'queued' end`,
      availableAt,
      leaseUntil: null,
      safeErrorCode: input.safeErrorCode,
      updatedAt: sql`now()`,
    })
    .where(eq(jobs.id, input.jobId));
}

export type EnqueueRequest = {
  kind: JobKind;
  aggregateId?: string;
  dedupeKey?: string;
  payload: Record<string, unknown>;
  schemaVersion?: number;
  availableAt?: Date;
  maxAttempts?: number;
};

/** 入队唯一入口: 业务代码通过它写入 jobs 表, 不再各自拼接 INSERT. */
export async function enqueue(input: { db: JobExecutor; job: EnqueueRequest }): Promise<void> {
  const availableAt = input.job.availableAt ?? new Date();
  const maxAttempts = input.job.maxAttempts ?? 5;
  await input.db
    .insert(jobs)
    .values({
      kind: input.job.kind,
      aggregateId: input.job.aggregateId ?? null,
      dedupeKey: input.job.dedupeKey ?? null,
      payload: input.job.payload,
      schemaVersion: input.job.schemaVersion ?? 1,
      availableAt,
      attempt: 0,
      maxAttempts,
      status: "queued",
    })
    .onConflictDoNothing({ target: [jobs.kind, jobs.aggregateId, jobs.dedupeKey] });
}

/**
 * 崩溃恢复: 把仍在活跃态但租约已过期的 run 批量重排为 run.wake 任务.
 * set-based INSERT..SELECT 单语句覆盖全表, 保留在跑 job 的既有租约. 表/列名一律由类型化列
 * 派生 (标识符位走 sql.identifier), schema 改名或删列编译期即报错, 不写裸字符串.
 */
export async function rearmStaleRuns(input: { db: JobExecutor }): Promise<void> {
  const id = (column: { name: string }) => sql.identifier(column.name);
  const active = and(
    inArray(runs.state, ["running", "waiting", "cancelling"]),
    or(isNull(runs.leaseUntil), lt(runs.leaseUntil, sql`now()`)),
  );
  await input.db.execute(sql`
    INSERT INTO ${sql.identifier(getTableName(jobs))} (${id(jobs.kind)}, ${id(jobs.aggregateId)}, ${id(jobs.dedupeKey)}, ${id(jobs.payload)},
      ${id(jobs.status)}, ${id(jobs.availableAt)}, ${id(jobs.maxAttempts)})
    SELECT 'run.wake', ${runs.conversationId}, 'recover:' || ${runs.id} || ':' || ${runs.revision},
      jsonb_build_object('conversationId', ${runs.conversationId}), 'queued', now(), 5
    FROM ${sql.identifier(getTableName(runs))}
    WHERE ${active}
    ON CONFLICT (${id(jobs.kind)}, ${id(jobs.aggregateId)}, ${id(jobs.dedupeKey)}) DO UPDATE SET
      ${id(jobs.status)} = CASE WHEN ${jobs.status} = 'running' THEN ${jobs.status} ELSE 'queued' END,
      ${id(jobs.availableAt)} = now()
  `);
}

function rowsOf(result: unknown): unknown[] {
  // drizzle node-postgres execute 的返回形态不稳定: 数组或 { rows }, 先收敛成行数组.
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) return result.rows;
  return [];
}

function mapRows(result: unknown): JobRecord[] {
  return rowsOf(result).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      jobId: String(r.id),
      kind: String(r.kind) as JobKind,
      aggregateId: r.aggregate_id == null ? null : String(r.aggregate_id),
      dedupeKey: r.dedupe_key == null ? null : String(r.dedupe_key),
      payload: (r.payload ?? {}) as Record<string, unknown>,
      schemaVersion: Number(r.schema_version ?? 1),
      availableAt: new Date(String(r.available_at)),
      attempt: Number(r.attempt ?? 1),
      maxAttempts: Number(r.max_attempts ?? 5),
      leaseUntil: r.lease_until == null ? null : new Date(String(r.lease_until)),
      status: String(r.status) as JobRecord["status"],
      safeErrorCode: r.safe_error_code == null ? null : String(r.safe_error_code),
      createdAt: new Date(String(r.created_at)),
      updatedAt: new Date(String(r.updated_at)),
    };
  });
}

export async function heartbeat(input: { db: JobExecutor; jobId: string; leaseSeconds: number }): Promise<void> {
  await input.db
    .update(jobs)
    .set({ leaseUntil: sql`now() + ${input.leaseSeconds} * interval '1 second'` })
    .where(and(eq(jobs.id, input.jobId), eq(jobs.status, "running")));
}
