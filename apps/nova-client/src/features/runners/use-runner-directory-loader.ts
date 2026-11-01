import type { RemoteExplorerListing } from '@nova/chat-ui';
import { useCallback } from 'react';
import { loadRunnerDirectory } from './runner.queries';

/**
 * 源参考 `useRunnerDirectoryLoader` 的等价实现 —— 直接复用 nova-dsh 的
 * `loadRunnerDirectory`，其签名（runnerId, path, signal）与 RemoteExplorer 期望
 * 的 `(path?, signal?) => Promise<RemoteExplorerListing>` 略有差异，这里包一层。
 */
export function useRunnerDirectoryLoader(runnerId: string) {
  return useCallback(
    async (path?: string, signal?: AbortSignal): Promise<RemoteExplorerListing> => {
      if (!runnerId) throw new Error('请先选择 Runner');
      return loadRunnerDirectory(runnerId, path ?? '.', signal) as Promise<RemoteExplorerListing>;
    },
    [runnerId],
  );
}
