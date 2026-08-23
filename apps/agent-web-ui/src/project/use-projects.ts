import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/provider.js";
import { queryKeys } from "../api/query-keys.js";

export function useProjects() {
  const { api } = useAuth();
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => api!.listProjects(),
    enabled: Boolean(api),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useProject(projectId: string | undefined) {
  const projects = useProjects();
  return {
    ...projects,
    project: projects.data?.find(project => project.id === projectId),
  };
}

export function useConversations(projectId?: string) {
  const { api } = useAuth();
  return useQuery({
    queryKey: queryKeys.conversations(projectId),
    queryFn: () => api!.listConversations(projectId),
    enabled: Boolean(api),
    staleTime: 5_000,
  });
}

export function useProjectMutations() {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.projects });
  return {
    create: useMutation({ mutationFn: (name: string) => api!.createProject({ name }), onSuccess: refresh }),
    rename: useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => api!.renameProject(id, { name }), onSuccess: refresh }),
    bind: useMutation({ mutationFn: ({ id, runnerId, path }: { id: string; runnerId: string; path: string }) => api!.bindProject(id, { runnerId, path }), onSuccess: refresh }),
    remove: useMutation({
      mutationFn: (id: string) => api!.deleteProject(id),
      onSuccess: async () => {
        await refresh();
        await queryClient.invalidateQueries({ queryKey: queryKeys.conversationLists });
      },
    }),
  };
}
