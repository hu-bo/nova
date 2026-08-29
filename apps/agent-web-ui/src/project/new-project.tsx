import { zodResolver } from "@hookform/resolvers/zod";
import { RemoteExplorer } from "@nova/chat-ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Folder, FolderKanban, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { errorMessage } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { useAuth } from "../auth/provider.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";
import { FieldLabel, Input } from "../components/ui/form.js";
import { RunnerSelect } from "../runner/runner-select.js";
import { useRunnerDirectoryLoader } from "../runner/use-runners.js";
import { newProjectSchema, type NewProjectForm } from "./schemas.js";

export function NewProjectDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api } = useAuth();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<NewProjectForm>({
    resolver: zodResolver(newProjectSchema),
    defaultValues: { name: "", runnerId: "", workspace: "" },
  });
  useEffect(() => {
    if (open) form.reset({ name: "", runnerId: "", workspace: "" });
    else setWorkspaceOpen(false);
  }, [open, form]);
  const create = useMutation({
    mutationFn: async (values: NewProjectForm) => {
      const project = await api!.createProject({ name: values.name });
      await api!.bindProject(project.id, { runnerId: values.runnerId, path: values.workspace });
      return project.id;
    },
    onSuccess: async (projectId) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      onClose();
      navigate(`/p/${projectId}`);
    },
  });
  const runnerId = form.watch("runnerId");
  const workspace = form.watch("workspace");
  const loadDirectory = useRunnerDirectoryLoader(runnerId);
  const selectedWorkspacePaths = useMemo(() => (workspace ? [workspace] : []), [workspace]);
  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title="新建项目"
        description="选择 Runner，并从它的根目录中选择 workspace。"
        size="lg"
      >
        <form onSubmit={form.handleSubmit((values) => create.mutate(values))} className="space-y-6">
          <div className="grid size-11 place-items-center rounded-xl bg-indigo-50 text-indigo-600">
            <FolderKanban className="size-5" aria-hidden="true" />
          </div>
          <FieldLabel label="项目名称" error={form.formState.errors.name?.message}>
            <Input data-initial-focus placeholder="例如 Nova" {...form.register("name")} />
          </FieldLabel>
          <FieldLabel label="Runner" error={form.formState.errors.runnerId?.message}>
            <RunnerSelect
              value={runnerId}
              onChange={(value) => {
                form.setValue("runnerId", value, { shouldValidate: true });
                form.setValue("workspace", "", { shouldValidate: true });
              }}
            />
          </FieldLabel>
          <FieldLabel label="Workspace" hint="从 Runner root 开始选择" error={form.formState.errors.workspace?.message}>
            <Button
              type="button"
              className="w-full justify-start"
              disabled={!runnerId}
              icon={<Folder className="size-4" aria-hidden="true" />}
              onClick={() => setWorkspaceOpen(true)}
            >
              <span className="truncate">{workspace || (runnerId ? "选择 workspace…" : "请先选择 Runner")}</span>
            </Button>
          </FieldLabel>
          {create.error && (
            <div role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-200">
              {errorMessage(create.error)}
            </div>
          )}
          <div className="flex justify-end gap-3 border-t border-slate-100 pt-5">
            <Button type="button" onClick={onClose}>
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={create.isPending}
              icon={<Plus className="size-4" aria-hidden="true" />}
            >
              {create.isPending ? "正在创建…" : "创建项目"}
            </Button>
          </div>
        </form>
      </Dialog>
      <RemoteExplorer
        open={workspaceOpen}
        onClose={() => setWorkspaceOpen(false)}
        loadDirectory={loadDirectory}
        mode="directory"
        initialPath={workspace || undefined}
        selectedPaths={selectedWorkspacePaths}
        onConfirm={(entries) => {
          const selected = entries[0];
          if (selected) form.setValue("workspace", selected.path, { shouldValidate: true });
          setWorkspaceOpen(false);
        }}
        title="选择 workspace"
      />
    </>
  );
}
