import { and, asc, eq, gt, inArray, or, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import type { RunControl } from "../modules/runtime/run-control.js";
import type { AgentStore } from "../store.js";
import { conversations, runs } from "./schema.js";
import { pgSessionStorage } from "./pg-session-storage.js";

export function pgRunControl(
  db: PostgresJsDatabase<Record<string, unknown>>,
  client: Sql,
  store: AgentStore,
  runnerGeneration: RunControl["runnerGeneration"],
): RunControl {
  let cursor: string | undefined;
  return {
    runnerGeneration,
    storage: (id) => pgSessionStorage(db, id),
    async claim(id) {
      const connection = await client.reserve();
      const [row] =
        await connection`select pg_try_advisory_lock(hashtextextended(${id}, 0)) as locked, pg_backend_pid() as pid`.catch(
          (error: unknown) => {
            connection.release();
            throw error;
          },
        );
      if (!row?.locked) {
        connection.release();
        return null;
      }
      const controller = new AbortController();
      let released = false;
      let checking = false;
      const timer = setInterval(() => {
        if (checking || released) return;
        checking = true;
        const timeout = setTimeout(() => controller.abort(new Error("Run ownership connection timed out")), 3000);
        void connection`select pg_backend_pid() as pid`.then(
          (rows) => {
            clearTimeout(timeout);
            checking = false;
            if (rows[0]?.pid !== row.pid) controller.abort(new Error("Run ownership connection changed"));
          },
          (error) => {
            clearTimeout(timeout);
            checking = false;
            controller.abort(error);
          },
        );
      }, 1000);
      timer.unref();
      return {
        signal: controller.signal,
        async release() {
          if (released) return;
          released = true;
          clearInterval(timer);
          try {
            await connection`select pg_advisory_unlock(hashtextextended(${id}, 0))`;
          } finally {
            connection.release();
          }
        },
      };
    },
    async candidates() {
      const page = () =>
        db
          .select({ id: conversations.id, userId: conversations.userId })
          .from(runs)
          .innerJoin(conversations, eq(conversations.id, runs.conversationId))
          .where(
            and(
              cursor ? gt(runs.conversationId, cursor) : undefined,
              or(
                inArray(runs.status, ["running", "paused"]),
                and(
                  eq(runs.status, "completed"),
                  sql`jsonb_array_length(coalesce(${runs.payload}->'queues'->'nextRun', '[]'::jsonb)) > 0`,
                ),
              ),
              or(
                isNull(runs.reason),
                inArray(runs.reason, ["runner_disconnected", "server_restart", "server_shutdown"]),
              ),
            ),
          )
          .orderBy(asc(runs.conversationId))
          .limit(32);
      let rows = await page();
      if (!rows.length && cursor) {
        cursor = undefined;
        rows = await page();
      }
      cursor = rows.at(-1)?.id;
      return Promise.all(rows.map((r) => store.routeConversation(r.userId, r.id)));
    },
  };
}
