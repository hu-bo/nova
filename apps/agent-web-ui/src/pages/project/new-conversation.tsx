import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { queryKeys } from "../../api/query-keys.js";
import { useAuth } from "../../auth/provider.js";
import { useModelSettings } from "../settings/model/provider.js";

export function useQuickConversationCreate() {
  const { api } = useAuth();
  const models = useModelSettings();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (project?: { id: string; runnerId: string | null }) => {
      const model = models.modelSelection(models.defaultProfileId || models.profiles[0]?.id || "");
      if (!model) throw new Error("该模型不可用，请在设置中配置模型或补充 API Key");
      return api!.createConversation({
        ...(project ? { projectId: project.id } : {}),
        ...(project?.runnerId ? { runnerId: project.runnerId } : {}),
        ...model,
      });
    },
    onSuccess: async (conversation) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.conversationLists });
      navigate(conversation.projectId ? `/p/${conversation.projectId}/c/${conversation.id}` : `/c/${conversation.id}`);
    },
  });
}
