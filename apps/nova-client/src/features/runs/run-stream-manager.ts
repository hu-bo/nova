import type { QueryClient } from '@tanstack/react-query';
import { productEventSchema } from '@nova/agent-ui-contracts';
import { getConversationSnapshot } from '@/api/generated/conversations';
import type { GetConversationSnapshot200 } from '@/api/generated/projectsAPI.schemas';
import { queryKeys } from '@/api/query-keys';
import { SseConnection, type SseConnectionState } from '@/api/sse-client';
import { serverReady } from '@/api/health';

import {
  initialRunState as initialProjection,
  isActiveRun,
  reduceRunState as reduceRunEvent,
  type RunState,
} from './run-state';
import type { RunProjection } from './run-event-reducer';

export type RunStreamSnapshot = {
  state: SseConnectionState;
  projection: RunProjection | null;
  error: string | null;
  retryAt: number | null;
};
export type RawRunStreamSnapshot = Omit<RunStreamSnapshot, 'projection'> & {
  projection: RunState | null;
};
const EMPTY: RawRunStreamSnapshot = {
  state: 'offline',
  projection: null,
  error: null,
  retryAt: null,
};
/** 订阅失败的 HTTP 状态 → 用户可读提示；未列出的状态不额外提示。 */
const STREAM_ERROR_BY_STATUS: Record<number, string> = {
  429: '实时订阅受到限制，请等待后重试。',
  503: '服务正在切换，已接收的任务状态会保留。',
  403: '没有权限订阅该会话。',
};
class Session {
  snapshot: RawRunStreamSnapshot = EMPTY;
  projected: RunState | null = null;
  connection: SseConnection | null = null;
  refs = 0;
  listeners = new Set<() => void>();
  batchTimer: ReturnType<typeof setTimeout> | null = null;
  pollTimer: ReturnType<typeof setInterval> | null = null;
  resync: Promise<string> | null = null;
  resyncFailures = 0;
  retryTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly id: string) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  publish(change: Partial<RawRunStreamSnapshot> = {}) {
    this.snapshot = { ...this.snapshot, ...change, projection: this.projected };
    for (const listener of this.listeners) listener();
  }
  flush() {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    this.publish();
  }
  dispose() {
    this.connection?.shutdown();
    this.connection = null;
    if (this.batchTimer) clearTimeout(this.batchTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.batchTimer = null;
    this.pollTimer = null;
  }
}
export class RunStreamManager {
  private sessions = new Map<string, Session>();
  private readonly controller = new AbortController();
  private hosts = 0;
  constructor(
    private readonly identityId: string,
    private readonly queryClient: QueryClient,
  ) {}
  retainHost() {
    this.hosts += 1;
    return () => {
      this.hosts -= 1;
      queueMicrotask(() => {
        if (!this.hosts) this.dispose();
      });
    };
  }
  session(id: string) {
    let session = this.sessions.get(id);
    if (!session) {
      session = new Session(id);
      this.sessions.set(id, session);
    }
    return session;
  }
  acquire(id: string, snapshot: GetConversationSnapshot200) {
    const session = this.session(id);
    this.seed(id, snapshot);
    session.refs += 1;
    this.open(session);
    return () => {
      session.refs = Math.max(0, session.refs - 1);
      queueMicrotask(() => {
        if (!session.refs && !isActiveRun(session.projected?.run?.state)) {
          session.dispose();
          this.sessions.delete(id);
        }
      });
    };
  }
  seed(id: string, snapshot: GetConversationSnapshot200) {
    const session = this.session(id);
    if (session.projected && BigInt(snapshot.cursor) < BigInt(session.projected.cursor)) return;
    session.projected = initialProjection(snapshot, session.projected ?? undefined);
    session.publish({ error: null });
  }
  retry(id: string) {
    const session = this.session(id);
    session.dispose();
    session.resyncFailures = 0;
    void this.resync(session)
      .then(() => this.open(session))
      .catch(() => session.publish({ state: 'offline', error: '暂时无法获取会话，请稍后重试。' }));
  }
  forget(id: string) {
    this.sessions.get(id)?.dispose();
    this.sessions.delete(id);
  }
  dispose() {
    this.controller.abort();
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
  private open(session: Session) {
    if (
      session.connection ||
      !session.projected ||
      this.controller.signal.aborted ||
      this.sessions.get(session.id) !== session
    )
      return;
    const connected = [...this.sessions.values()].filter((item) => item.connection);
    if (connected.length >= 4) {
      const candidate = connected.find((item) => !item.refs);
      if (candidate) {
        candidate.connection?.shutdown();
        candidate.connection = null;
        candidate.publish({ state: 'offline', error: '后台会话按快照更新。' });
        candidate.pollTimer ??= setInterval(() => {
          void this.resync(candidate).catch(() =>
            candidate.publish({ error: '后台会话暂时无法更新。' }),
          );
        }, 60000);
      } else {
        session.publish({ state: 'offline', error: '已达到同时订阅上限，请关闭其他会话后重试。' });
        return;
      }
    }
    if (session.pollTimer) {
      clearInterval(session.pollTimer);
      session.pollTimer = null;
    }
    const base = (
      import.meta.env.VITE_SSE_BASE_URL ||
      import.meta.env.VITE_API_BASE_URL ||
      ''
    ).replace(/\/$/, '');
    session.connection = new SseConnection({
      url: `${base}/api/conversations/${session.id}/events`,
      cursor: session.projected.cursor,
      checkReady: serverReady,
      onStateChange: (state) => {
        if (import.meta.env.DEV)
          console.debug('[runs] 连接 → %s（恢复游标 %s）', state, session.projected?.cursor ?? '-');
        session.publish(state === 'live' ? { state, error: null, retryAt: null } : { state });
      },
      onError: ({ status, retryAfterSeconds }) => {
        if (import.meta.env.DEV)
          console.debug(
            '[runs] 订阅失败 HTTP %s（retry-after %s 秒）',
            status ?? '-',
            retryAfterSeconds ?? 0,
          );
        session.publish({
          error: STREAM_ERROR_BY_STATUS[status] ?? null,
          retryAt: retryAfterSeconds ? Date.now() + retryAfterSeconds * 1000 : null,
        });
      },
      onSnapshotRequired: () => this.resync(session),
      onFrame: (frame) => {
        if (!session.projected || session.resync) return undefined;
        const parsed = productEventSchema.safeParse(frame.data);
        if (
          !parsed.success ||
          frame.eventId !== session.id + ':' + parsed.data.sequence ||
          frame.eventName !== parsed.data.type
        ) {
          if (import.meta.env.DEV)
            console.debug(
              '[runs] 事件校验失败：帧 %s（%s），期望 %s:%s（%s）',
              frame.eventId,
              frame.eventName,
              session.id,
              parsed.success ? parsed.data.sequence : '?',
              parsed.success ? parsed.data.type : '?',
            );
          session.connection?.shutdown();
          session.connection = null;
          session.publish({
            state: 'offline',
            error: '事件协议无法识别，请更新客户端后重新连接。',
          });
          return undefined;
        }
        session.projected = reduceRunEvent(session.projected, parsed.data);
        if (parsed.data.type === 'input.rejected')
          session.publish({ error: parsed.data.payload.error.message });
        if (session.projected.needsSnapshot) {
          this.refresh(session);
          return undefined;
        }
        session.resyncFailures = 0;
        if (['text.delta', 'tool.output'].includes(parsed.data.type)) {
          session.batchTimer ??= setTimeout(() => session.flush(), 16);
        } else session.flush();
        if (parsed.data.type === 'message.committed' || parsed.data.type === 'run.changed')
          void this.queryClient.invalidateQueries({
            queryKey: queryKeys.conversations.list(this.identityId, { limit: 100 }),
            refetchType: 'active',
          });
        if (!session.refs && !isActiveRun(session.projected.run?.state)) {
          session.dispose();
          this.sessions.delete(session.id);
        }
        return session.projected.cursor;
      },
    });
  }
  private refresh(session: Session) {
    session.connection?.shutdown();
    session.connection = null;
    if (++session.resyncFailures > 3) {
      if (import.meta.env.DEV) console.debug('[runs] 快照对齐连续失败超过 3 次，停止自动重试');
      session.publish({ state: 'offline', error: '事件无法对齐，请重新连接。' });
      return;
    }
    if (import.meta.env.DEV)
      console.debug('[runs] 事件无法应用，转快照重建（连续第 %d 次）', session.resyncFailures);
    session.retryTimer = setTimeout(
      () => {
        session.retryTimer = null;
        void this.resync(session)
          .then(() => this.open(session))
          .catch(() => session.publish({ state: 'offline', error: '无法对齐最新快照，请重试。' }));
      },
      Math.min(4000, 250 * 2 ** session.resyncFailures),
    );
  }
  private resync(session: Session): Promise<string> {
    if (!session.resync) {
      session.resync = getConversationSnapshot(session.id, { signal: this.controller.signal })
        .then((snapshot) => {
          if (this.controller.signal.aborted || this.sessions.get(session.id) !== session)
            throw new DOMException('Disposed', 'AbortError');
          // Cursor and projection are replaced together; drafts belong to the composer and survive this operation.
          if (!session.projected || BigInt(snapshot.cursor) >= BigInt(session.projected.cursor)) {
            this.queryClient.setQueryData(
              queryKeys.conversations.snapshot(this.identityId, session.id),
              snapshot,
            );
            session.projected = initialProjection(snapshot, session.projected ?? undefined);
            session.flush();
          }
          return session.projected?.cursor ?? snapshot.cursor;
        })
        .finally(() => {
          session.resync = null;
        });
    }
    return session.resync;
  }
}
