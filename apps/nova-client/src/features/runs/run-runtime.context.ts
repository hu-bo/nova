import { useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { GetConversationSnapshot200 } from '@/api/generated/projectsAPI.schemas';
import type { RawRunStreamSnapshot } from './run-stream-manager';
import { RunStreamContext } from './run-context';
import { initialProjection, projectRunState } from './run-event-reducer';

const EMPTY: RawRunStreamSnapshot = {
  state: 'offline',
  projection: null,
  error: null,
  retryAt: null,
};

/**
 * 流式运行时上下文。与 `run-runtime.tsx` 的宿主组件分开存放：该模块只导出非组件值，
 * 保持 React Fast Refresh 的「边界模块只导出组件」约定，编辑宿主组件时不会整页重载。
 */
export { RunStreamContext } from './run-context';

export function useConversationStream(
  id: string | null,
  snapshot: GetConversationSnapshot200 | undefined,
) {
  const manager = useContext(RunStreamContext);
  if (!manager) throw new Error('RunRuntimeHost missing');
  const session = useMemo(() => (id ? manager.session(id) : null), [id, manager]);
  const stream = useSyncExternalStore(
    session?.subscribe ?? (() => () => {}),
    session?.getSnapshot ?? (() => EMPTY),
  );
  // Protocol events advance immediately; presentation is derived only when a frame is published.
  const projection = useMemo(() => {
    if (stream.projection) return projectRunState(stream.projection);
    if (snapshot) return initialProjection(snapshot);
    return null;
  }, [stream.projection, snapshot]);
  useEffect(() => {
    if (!id || !snapshot) return;
    return manager.acquire(id, snapshot);
    // Only acquire after the initial snapshot. Subsequent snapshots seed the same subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, manager, Boolean(snapshot)]);
  useEffect(() => {
    if (id && snapshot) manager.seed(id, snapshot);
  }, [id, snapshot, manager]);
  return {
    ...stream,
    projection,
    retry: () => (id ? manager.retry(id) : Promise.resolve(false)),
    forget: () => {
      if (id) manager.forget(id);
    },
  };
}
