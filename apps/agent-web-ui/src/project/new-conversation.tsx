import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, FolderKanban, MessageCircle, Plus } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { errorMessage } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { useAuth } from "../auth/provider.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";
import { FieldLabel, Input, Select } from "../components/ui/form.js";
import { useModelSettings } from "../model/provider.js";
import { newConversationSchema, type NewConversationForm } from "./schemas.js";
import { useProjects } from "./use-projects.js";
import { RunnerSelect } from "../runner/runner-select.js";
import { WorkspacePicker } from "../runner/workspace-picker.js";

export interface NewConversationDialogProps {
  open: boolean;
  onClose: () => void;
  initialProjectId?: string;
  initialMode?: "chat" | "project";
}

export function NewConversationDialog({ open, onClose, initialProjectId, initialMode }: NewConversationDialogProps) {
  const { api } = useAuth();
  const projects = useProjects();
  const models = useModelSettings();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<NewConversationForm>({
    resolver: zodResolver(newConversationSchema),
    defaultValues: {
      mode: initialProjectId ? "project" : initialMode ?? "chat",
      title: "",
      modelProfileId: models.defaultProfileId,
      runnerId: models.defaultRunnerId,
      projectId: initialProjectId ?? "",
      projectName: "",
      workspace: "",
    },
  });
  const mode = form.watch("mode");
  const projectId = form.watch("projectId");

  useEffect(() => {
    if (!open) return;
    form.reset({
      mode: initialProjectId ? "project" : initialMode ?? "chat",
      title: "",
      modelProfileId: models.defaultProfileId,
      runnerId: models.defaultRunnerId,
      projectId: initialProjectId ?? "",
      projectName: "",
      workspace: "",
    });
  }, [open, initialProjectId, initialMode, models.defaultProfileId, models.defaultRunnerId, form]);

  const create = useMutation({
    mutationFn: async (values: NewConversationForm) => {
      const model = models.modelSelection(values.modelProfileId);
      if (!model) throw new Error("该模型不可用，请选择其他模型或补充 API Key");
      let targetProjectId: string | undefined;
      let runnerId = values.runnerId;

      if (values.mode === "project") {
        if (values.projectId === "new") {
          const project = await api!.createProject({ name: values.projectName });
          targetProjectId = project.id;
          await api!.bindProject(project.id, { runnerId: values.runnerId, path: values.workspace });
        } else {
          const project = projects.data?.find(item => item.id === values.projectId);
          if (!project) throw new Error("选择的项目不存在或已被删除");
          if (!project.runnerId || !project.workspace) throw new Error("该项目尚未绑定 Runner 和 workspace");
          targetProjectId = project.id;
          runnerId = project.runnerId;
        }
      }

      return api!.createConversation({
        ...(values.title ? { title: values.title } : {}),
        ...(targetProjectId ? { projectId: targetProjectId } : {}),
        runnerId,
        ...model,
      });
    },
    onSuccess: async conversation => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
        queryClient.invalidateQueries({ queryKey: queryKeys.conversationLists }),
      ]);
      onClose();
      navigate(conversation.projectId ? `/p/${conversation.projectId}/c/${conversation.id}` : `/c/${conversation.id}`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
  });

  const submit = form.handleSubmit(values => create.mutate(values));
  const fieldErrors = form.formState.errors;

  return (
    <Dialog open={open} onClose={onClose} title={initialProjectId ? "新建 Project 会话" : initialMode === "chat" ? "新建普通会话" : "开始一个新会话"} description={initialProjectId ? "新会话将使用当前 Project 的 Runner 与 workspace。" : initialMode === "chat" ? "用于讨论、分析和多步规划。" : "模式创建后不可更改；需要访问代码时请选择 Project。"} size="lg">
      <form onSubmit={submit} className="space-y-6">
        {!initialProjectId && !initialMode && <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="会话模式">
          <ModeOption
            active={mode === "chat"}
            icon={<MessageCircle className="size-5" aria-hidden="true" />}
            title="直接开始聊"
            description="用于讨论、分析和多步规划"
            onClick={() => form.setValue("mode", "chat", { shouldValidate: true })}
          />
          <ModeOption
            active={mode === "project"}
            icon={<FolderKanban className="size-5" aria-hidden="true" />}
            title="在项目里工作"
            description="让 Agent 访问真实 workspace"
            onClick={() => form.setValue("mode", "project", { shouldValidate: true })}
          />
        </div>}

        <div className="grid gap-5 sm:grid-cols-2">
          <FieldLabel label="会话标题" hint="可选" error={fieldErrors.title?.message}>
            <Input placeholder="例如：重构登录流程" {...form.register("title")} />
          </FieldLabel>
          <FieldLabel label="模型配置" error={fieldErrors.modelProfileId?.message}>
            <Select {...form.register("modelProfileId")}>
              <option value="">选择模型</option>
              {models.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.model} ({profile.providerName})</option>)}
            </Select>
          </FieldLabel>
        </div>

        {mode === "chat" && (
          <FieldLabel label="Runner" hint="Chat 保留设备归属，但不会使用文件工具" error={fieldErrors.runnerId?.message}>
            <RunnerSelect value={form.watch("runnerId")} onChange={value => form.setValue("runnerId", value, { shouldValidate: true })} />
          </FieldLabel>
        )}

        {mode === "project" && (
          <div className="space-y-5 rounded-xl bg-slate-50 p-5 ring-1 ring-slate-200">
            <FieldLabel label="选择项目" error={fieldErrors.projectId?.message}>
              <Select {...form.register("projectId")}>
                <option value="">选择已有项目</option>
                {projects.data?.map(project => (
                  <option key={project.id} value={project.id}>{project.name}{project.workspace ? ` · ${project.workspace}` : "（待绑定）"}</option>
                ))}
                <option value="new">＋ 新建项目</option>
              </Select>
            </FieldLabel>
            {projectId === "new" && (
              <div className="grid gap-5 sm:grid-cols-2">
                <FieldLabel label="项目名称" error={fieldErrors.projectName?.message}>
                  <Input placeholder="Nova Web" {...form.register("projectName")} />
                </FieldLabel>
                <FieldLabel label="Runner" error={fieldErrors.runnerId?.message}>
                  <RunnerSelect value={form.watch("runnerId")} onChange={value => { form.setValue("runnerId", value, { shouldValidate: true }); form.setValue("workspace", "", { shouldValidate: true }); }} />
                </FieldLabel>
                <div className="sm:col-span-2">
                  <FieldLabel label="Workspace" hint="从 Runner root 开始选择" error={fieldErrors.workspace?.message}>
                    <WorkspacePicker runnerId={form.watch("runnerId")} value={form.watch("workspace")} onChange={value => form.setValue("workspace", value, { shouldValidate: true })} />
                  </FieldLabel>
                </div>
              </div>
            )}
          </div>
        )}

        {create.error && <div role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-200">{errorMessage(create.error)}</div>}

        <div className="flex flex-col-reverse gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:justify-end">
          <Button type="button" onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" disabled={create.isPending} icon={create.isPending ? undefined : <Plus className="size-4" aria-hidden="true" />}>
            {create.isPending ? "正在创建…" : "创建并进入"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ModeOption({ active, icon, title, description, onClick }: { active: boolean; icon: React.ReactNode; title: string; description: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`relative rounded-xl p-4 text-left ring-1 transition ${active ? "bg-indigo-50 ring-indigo-300" : "bg-white ring-slate-200 hover:bg-slate-50"}`}
    >
      <span className={`mb-3 grid size-9 place-items-center rounded-lg ${active ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"}`}>{icon}</span>
      <strong className="block text-sm text-slate-900">{title}</strong>
      <span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span>
      {active && <Check className="absolute right-4 top-4 size-4 text-indigo-600" aria-hidden="true" />}
    </button>
  );
}
