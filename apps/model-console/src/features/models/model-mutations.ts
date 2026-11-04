import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createModel, deleteModel, updateModel, type CreateModel, type Model } from "@/api/client";
import { modelKeys } from "./model-queries";
import { toModelInput } from "./model-input";

export function useModelMutations(editing: Model | null) {
  const queryClient = useQueryClient();
  const invalidateModels = () => queryClient.invalidateQueries({ queryKey: modelKeys.all });
  const saveMutation = useMutation({
    mutationFn: (input: CreateModel) => (editing ? updateModel(editing.id, input) : createModel(input)),
    onSuccess: () => invalidateModels(),
  });
  const stateMutation = useMutation({
    mutationFn: ({ model, enabled }: { model: Model; enabled: boolean }) =>
      updateModel(model.id, { ...toModelInput(model), enabled }),
    onSuccess: async () => {
      await invalidateModels();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (model: Model) => deleteModel(model.id),
    onSuccess: async () => {
      await invalidateModels();
    },
  });
  return { saveMutation, stateMutation, deleteMutation };
}
