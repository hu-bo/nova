import { useQuery } from '@tanstack/react-query';
import { getClientConfig } from '@/api/generated/config';
import { useIdentity } from '@/features/auth';

/**
 * 拉取 `GET /api/config` 返回的客户端配置（含 capabilities、模型目录）。
 * 设置页的「模型配置」tab 用它合成服务端模型 profile（`source: "server"`）。
 */
export function useClientConfig() {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: ['nova', identity?.identityId ?? 'anonymous', 'config'],
    enabled: Boolean(identity),
    queryFn: ({ signal }) => getClientConfig({ signal }),
    staleTime: 60000,
    gcTime: 300000,
  });
}
