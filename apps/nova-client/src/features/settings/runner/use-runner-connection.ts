import { useQuery } from '@tanstack/react-query';
import { getRunnerConnectionInfo } from '@/api/generated/runners';
import { useIdentity } from '@/features/auth';
export function useRunnerConnection(enabled = true) {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: ['nova', identity?.identityId ?? 'anonymous', 'runner-connection'],
    enabled: enabled && Boolean(identity),
    queryFn: ({ signal }) => getRunnerConnectionInfo({ signal }),
    staleTime: 60000,
  });
}
