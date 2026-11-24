import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import {
  downloadArtifact,
  listConversationArtifacts,
  previewArtifact,
} from '@/api/generated/artifacts';
import { queryKeys } from '@/api/query-keys';
import { useIdentity } from '@/features/auth';

const LIST_PAGE_SIZE = 50;

/**
 * 会话产物查询封装（P1-G1）。列表走 `GET /api/conversations/:id/artifacts`（cursor 分页），
 * 查询键按账号+会话隔离；artifact.changed 事件与断线重连都只失效列表键，由服务端接口兜底。
 */
export function useConversationArtifactsQuery(conversationId: string | null) {
  const { identity } = useIdentity();
  return useInfiniteQuery({
    queryKey: queryKeys.artifacts.list(identity?.identityId ?? 'anonymous', conversationId ?? ''),
    enabled: Boolean(identity && conversationId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listConversationArtifacts(
        conversationId!,
        {
          limit: LIST_PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/**
 * 预览按需拉取（GET /api/artifacts/:id/preview）：markdown/text 返回受限文本，
 * image 返回短期 URL；staleTime 取 0，重开预览重新换签，不依赖过期 URL。
 */
export function useArtifactPreviewQuery(artifactId: string | null) {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: queryKeys.artifacts.preview(identity?.identityId ?? 'anonymous', artifactId ?? ''),
    enabled: Boolean(identity && artifactId),
    staleTime: 0,
    queryFn: ({ signal }) => previewArtifact(artifactId!, { signal }),
  });
}

/**
 * 下载换签（GET /api/artifacts/:id/download）：URL 只在点击后使用一次，
 * 不进查询缓存、不持久化，也不在前端拼接对象键。
 */
export function useArtifactDownloadMutation() {
  return useMutation({
    mutationFn: (artifactId: string) => downloadArtifact(artifactId),
  });
}
