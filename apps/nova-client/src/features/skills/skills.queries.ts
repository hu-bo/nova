import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSkillVersion, listAgents, listSkills } from '@/api/generated/skills';
import { refreshRunnerResources } from '@/api/generated/runners';
import type {
  ListAgentsParams,
  ListSkillsParams,
  RefreshRunnerResourcesBody,
} from '@/api/generated/projectsAPI.schemas';
import { queryKeys } from '@/api/query-keys';
import { useIdentity } from '@/features/auth';

const CATALOG_PAGE_SIZE = 50;

/** 技能目录条目：GET /api/skills 返回项（契约 skillCatalogEntrySchema 的生成形状）。 */
export type SkillCatalogEntry = Awaited<ReturnType<typeof listSkills>>['items'][number];

/** 环境筛选：conversationId 按会话原绑定解析，projectId 按项目当前绑定，runnerId 为纯设备全局层（§8.2）。 */
export type SkillEnvironmentFilters = {
  conversationId?: string | undefined;
  projectId?: string | undefined;
  runnerId?: string | undefined;
  source?: ListSkillsParams['source'];
  q?: string | undefined;
};

function catalogKeyFilters(filters: SkillEnvironmentFilters): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) if (typeof value === 'string' && value) next[key] = value;
  return next;
}

function catalogParams(filters: SkillEnvironmentFilters, cursor?: string): ListSkillsParams {
  const params: ListSkillsParams = { limit: CATALOG_PAGE_SIZE };
  if (filters.conversationId) params.conversationId = filters.conversationId;
  if (filters.projectId) params.projectId = filters.projectId;
  if (filters.runnerId) params.runnerId = filters.runnerId;
  if (filters.source) params.source = filters.source;
  if (filters.q) params.q = filters.q;
  if (cursor) params.cursor = cursor;
  return params;
}

/** 合并技能目录（内置/平台/Runner 全局/项目）：分页与筛选走服务端，查询键按账号+环境隔离。 */
export function useSkillCatalogQuery(
  filters: SkillEnvironmentFilters,
  options: { enabled?: boolean } = {},
) {
  const { identity } = useIdentity();
  return useInfiniteQuery({
    queryKey: queryKeys.skills.catalog(identity?.identityId ?? 'anonymous', catalogKeyFilters(filters)),
    enabled: options.enabled !== false && Boolean(identity),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => listSkills(catalogParams(filters, pageParam), { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/** Agent 目录（GET /api/agents）：仅按会话或项目解析环境；无结果时客户端隐藏 Agent 选择器。 */
export function useAgentCatalogQuery(
  filters: Pick<SkillEnvironmentFilters, 'conversationId' | 'projectId'>,
  options: { enabled?: boolean } = {},
) {
  const { identity } = useIdentity();
  const params: ListAgentsParams = {};
  if (filters.conversationId) params.conversationId = filters.conversationId;
  else if (filters.projectId) params.projectId = filters.projectId;
  return useQuery({
    queryKey: queryKeys.skills.agents(identity?.identityId ?? 'anonymous', params),
    enabled: options.enabled !== false && Boolean(identity),
    queryFn: ({ signal }) => listAgents(params, { signal }),
  });
}

/** 版本详情按需加载（列表只回摘要）：正文走 GET /skills/:id/versions/:version。 */
export function useSkillVersionDetailQuery(skillId: string | null, version: string | null) {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: queryKeys.skills.version(
      identity?.identityId ?? 'anonymous',
      skillId ?? '',
      version ?? '',
    ),
    enabled: Boolean(identity && skillId && version),
    queryFn: ({ signal }) => getSkillVersion(skillId!, version!, { signal }),
  });
}

/** 定向刷新 Runner 本地技能；成功后失效目录查询（失败时服务端保留旧目录并标过期，由状态呈现）。 */
export function useRefreshRunnerSkillsMutation() {
  const { identity } = useIdentity();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { runnerId: string; body: RefreshRunnerResourcesBody }) =>
      refreshRunnerResources(input.runnerId, input.body),
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: queryKeys.skills.root(identity?.identityId ?? 'anonymous'),
      });
    },
  });
}
