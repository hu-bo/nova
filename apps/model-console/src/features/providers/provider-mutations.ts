import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createProvider,
  deleteProvider,
  updateProvider,
  type CreateProvider,
  type Provider,
  type UpdateProvider,
} from "@/api/client";
import { providerKeys } from "./provider-queries";
import { modelKeys } from "@/features/models";

export function useProviderMutations(editing: Provider | null) {
  const queryClient = useQueryClient();
  // Provider 变更会级联影响模型展示，两个列表都要失效。
  const invalidateConfig = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: providerKeys.all }),
      queryClient.invalidateQueries({ queryKey: modelKeys.all }),
    ]);
  const saveMutation = useMutation({
    mutationFn: (input: CreateProvider | UpdateProvider) =>
      editing ? updateProvider(editing.id, input) : createProvider(input as CreateProvider),
    onSuccess: () => invalidateConfig(),
  });
  const stateMutation = useMutation({
    mutationFn: ({ provider, enabled }: { provider: Provider; enabled: boolean }) =>
      updateProvider(provider.id, { enabled }),
    onSuccess: async () => {
      await invalidateConfig();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (provider: Provider) => deleteProvider(provider.id),
    onSuccess: async () => {
      await invalidateConfig();
    },
  });
  return { saveMutation, stateMutation, deleteMutation };
}
