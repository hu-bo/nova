import { zodResolver } from "@hookform/resolvers/zod";
import { RemoteExplorer } from "@nova/chat-ui";
import { ArrowRight, Folder, FolderKanban, MessageCircle, Pencil, Plus, Server, Trash2, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate, useParams } from "react-router-dom";
import { errorMessage } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { Card } from "../../components/ui/card.js";
import { Dialog } from "../../components/ui/dialog.js";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/feedback.js";
import { FieldLabel, Input } from "../../components/ui/form.js";
import { useQuickConversationCreate } from "./new-conversation.js";
import { bindWorkspaceSchema, renameProjectSchema, type BindWorkspaceForm, type RenameProjectForm } from "./schemas.js";
import { useConversations, useProject, useProjectMutations } from "./use-projects.js";
import { RunnerBadge } from "../home.js";
import { RunnerManagerDialog } from "../settings/runner/runner-manager-dialog.js";
import { RunnerSelect } from "../settings/runner/runner-select.js";
import { useRunnerDirectoryLoader } from "../settings/runner/use-runners.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table.js";

export function ProjectRoute() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const projectQuery = useProject(projectId);
  const conversations = useConversations(projectId);
  const mutations = useProjectMutations();
  const [renameOpen, setRenameOpen] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [runnerManagerOpen, setRunnerManagerOpen] = useState(false);
  const [deleteValue, setDeleteValue] = useState("");

  const renameForm = useForm<RenameProjectForm>({
    resolver: zodResolver(renameProjectSchema),
    defaultValues: { name: "" },
  });
  const bindForm = useForm<BindWorkspaceForm>({
    resolver: zodResolver(bindWorkspaceSchema),
    defaultValues: { runnerId: "", workspace: "" },
  });
  const project = projectQuery.project;
  const createConversation = useQuickConversationCreate();
  const bindRunnerId = bindForm.watch("runnerId");
  const bindWorkspace = bindForm.watch("workspace");
  const loadDirectory = useRunnerDirectoryLoader(bindRunnerId);
  const selectedWorkspacePaths = useMemo(() => (bindWorkspace ? [bindWorkspace] : []), [bindWorkspace]);

  useEffect(() => {
    if (project && renameOpen) renameForm.reset({ name: project.name });
  }, [project, renameOpen, renameForm]);
  useEffect(() => {
    if (project && bindOpen) bindForm.reset({ runnerId: project.runnerId ?? "", workspace: project.workspace ?? "" });
  }, [project, bindOpen, bindForm]);
  useEffect(() => {
    if (!bindOpen) setWorkspaceOpen(false);
  }, [bindOpen]);

  if (!projectId)
    return (
      <div className="p-8">
        <ErrorState message="Project 路径无效" />
      </div>
    );
  if (projectQuery.isLoading || conversations.isLoading)
    return (
      <div className="p-6 lg:p-8">
        <LoadingState label="正在加载 Project" />
      </div>
    );
  if (projectQuery.error)
    return (
      <div className="p-6 lg:p-8">
        <ErrorState message={errorMessage(projectQuery.error)} onRetry={() => void projectQuery.refetch()} />
      </div>
    );
  if (!project)
    return (
      <div className="p-6 lg:p-8">
        <ErrorState title="Project 不存在" message="它可能已被删除，或你没有访问权限。" />
      </div>
    );
  if (conversations.error)
    return (
      <div className="p-6 lg:p-8">
        <ErrorState message={errorMessage(conversations.error)} onRetry={() => void conversations.refetch()} />
      </div>
    );

  const conversationItems = conversations.data?.items ?? [];
  async function rename(values: RenameProjectForm) {
    await mutations.rename.mutateAsync({ id: project!.id, name: values.name });
    setRenameOpen(false);
  }
  async function bind(values: BindWorkspaceForm) {
    await mutations.bind.mutateAsync({ id: project!.id, runnerId: values.runnerId, path: values.workspace });
    setBindOpen(false);
  }
  async function remove() {
    await mutations.remove.mutateAsync(project!.id);
    navigate("/app", { replace: true });
  }

  return (
    <div className="mx-auto max-w-[1400px] p-5 sm:p-6 lg:p-8">
      <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid size-11 place-items-center rounded-xl bg-indigo-50 text-indigo-600">
              <FolderKanban className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold tracking-tight text-slate-950">{project.name}</h1>
              <p className="mt-1 max-w-3xl truncate text-sm text-slate-500" title={project.workspace ?? undefined}>
                {project.workspace ?? "尚未绑定 workspace"}
              </p>
            </div>
            <RunnerBadge state={project.runnerState} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setRenameOpen(true)} icon={<Pencil className="size-4" aria-hidden="true" />}>
            重命名
          </Button>
          <Button onClick={() => setBindOpen(true)} icon={<Server className="size-4" aria-hidden="true" />}>
            {project.workspace ? "更换绑定" : "绑定 workspace"}
          </Button>
          <Button
            variant="primary"
            disabled={createConversation.isPending}
            onClick={() => createConversation.mutate({ id: project.id, runnerId: project.runnerId })}
            icon={<Plus className="size-4" aria-hidden="true" />}
          >
            {createConversation.isPending ? "正在创建…" : "新建会话"}
          </Button>
        </div>
      </div>

      {createConversation.error && (
        <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-200" role="alert">
          新建会话失败：{errorMessage(createConversation.error)}
        </p>
      )}

      {project.runnerState === "disconnected" && (
        <section className="mt-8 rounded-xl bg-amber-50 p-5 ring-1 ring-amber-200" aria-labelledby="runner-guide-title">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-700">
              <Unplug className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="runner-guide-title" className="font-semibold text-amber-950">
                Runner 未连接
              </h2>
              <p className="mt-1 text-sm leading-6 text-amber-800">
                Composer 不会静默降级成普通 Chat。请启动已归属当前账号的 Runner，恢复后状态会自动刷新。
              </p>
              <Button className="mt-3" variant="outline" onClick={() => setRunnerManagerOpen(true)}>
                查看 token 与启动命令
              </Button>
            </div>
          </div>
        </section>
      )}

      <section className="mt-8 grid gap-4 sm:grid-cols-3" aria-label="Project 概览">
        <Card className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Conversations</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{conversationItems.length}</p>
          <p className="mt-2 text-xs text-slate-500">共享同一个 Project 上下文</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Runner</p>
          <p className="mt-2 truncate text-lg font-semibold text-slate-950">{project.runnerId ?? "未绑定"}</p>
          <p className="mt-2 text-xs text-slate-500">设备级资源归属</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Workspace</p>
          <p className="mt-2 truncate text-lg font-semibold text-slate-950" title={project.workspace ?? undefined}>
            {project.workspace ?? "待选择"}
          </p>
          <p className="mt-2 text-xs text-slate-500">消息创建后不可切换模式</p>
        </Card>
      </section>

      <section className="mt-8">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-900">会话</h2>
          <p className="mt-1 text-sm text-slate-500">继续最近任务，或开始一个新的目标</p>
        </div>
        {conversationItems.length ? (
          <Card className="overflow-hidden">
            <Table className="min-w-[620px]">
              <TableHeader>
                <TableRow>
                  <TableHead>会话</TableHead>
                  <TableHead>Runner</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead className="w-16">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {conversationItems.map((conversation) => (
                  <TableRow key={conversation.id}>
                    <TableCell>
                      <Link
                        className="font-medium text-slate-900 hover:text-indigo-700"
                        to={`/p/${project.id}/c/${conversation.id}`}
                      >
                        {conversation.title || "未命名会话"}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{conversation.runnerId}</TableCell>
                    <TableCell>
                      {new Intl.DateTimeFormat("zh-CN", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(conversation.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <Link
                        to={`/p/${project.id}/c/${conversation.id}`}
                        aria-label={`打开 ${conversation.title}`}
                        className="grid size-8 place-items-center rounded-lg text-slate-400 hover:bg-indigo-50 hover:text-indigo-600"
                      >
                        <ArrowRight className="size-4" aria-hidden="true" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ) : (
          <EmptyState
            icon={<MessageCircle className="size-5" aria-hidden="true" />}
            title="这个 Project 还没有会话"
            description={
              project.workspace
                ? "创建会话，让 Agent 在当前 workspace 中开始工作。"
                : "先绑定 Runner 与 workspace，才能创建 coding 会话。"
            }
            action={
              <div className="flex flex-col items-center gap-3">
                <Button
                  variant="primary"
                  disabled={createConversation.isPending}
                  onClick={() => createConversation.mutate({ id: project.id, runnerId: project.runnerId })}
                  icon={<Plus className="size-4" />}
                >
                  {createConversation.isPending ? "正在创建…" : "新建会话"}
                </Button>
                {createConversation.error && (
                  <p className="max-w-sm text-center text-sm text-rose-600" role="alert">
                    {errorMessage(createConversation.error)}
                  </p>
                )}
              </div>
            }
          />
        )}
      </section>

      <section className="mt-10 flex justify-end border-t border-slate-200 pt-6">
        <Button
          variant="ghost"
          className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
          icon={<Trash2 className="size-4" aria-hidden="true" />}
          onClick={() => {
            setDeleteValue("");
            setDeleteOpen(true);
          }}
        >
          删除 Project
        </Button>
      </section>

      <Dialog open={renameOpen} onClose={() => setRenameOpen(false)} title="重命名 Project">
        <form onSubmit={renameForm.handleSubmit((values) => void rename(values))} className="space-y-5">
          <FieldLabel label="项目名称" error={renameForm.formState.errors.name?.message}>
            <Input autoFocus {...renameForm.register("name")} />
          </FieldLabel>
          {mutations.rename.error && (
            <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">
              {errorMessage(mutations.rename.error)}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button type="button" onClick={() => setRenameOpen(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={mutations.rename.isPending}>
              {mutations.rename.isPending ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={bindOpen}
        onClose={() => setBindOpen(false)}
        title="绑定 Runner 与 workspace"
        description="路径必须存在、位于 Runner root 内，且当前账号拥有该 Runner。"
      >
        <form onSubmit={bindForm.handleSubmit((values) => void bind(values))} className="space-y-5">
          <FieldLabel label="Runner" error={bindForm.formState.errors.runnerId?.message}>
            <RunnerSelect
              value={bindRunnerId}
              onChange={(value) => {
                bindForm.setValue("runnerId", value, { shouldValidate: true });
                bindForm.setValue("workspace", "", { shouldValidate: true });
              }}
            />
          </FieldLabel>
          <FieldLabel
            label="Workspace"
            hint="从 Runner root 开始选择"
            error={bindForm.formState.errors.workspace?.message}
          >
            <Button
              type="button"
              className="w-full justify-start"
              disabled={!bindRunnerId}
              icon={<Folder className="size-4" aria-hidden="true" />}
              onClick={() => setWorkspaceOpen(true)}
            >
              <span className="truncate">
                {bindWorkspace || (bindRunnerId ? "选择 workspace…" : "请先选择 Runner")}
              </span>
            </Button>
          </FieldLabel>
          {mutations.bind.error && (
            <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">
              {errorMessage(mutations.bind.error)}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button type="button" onClick={() => setBindOpen(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={mutations.bind.isPending}>
              {mutations.bind.isPending ? "正在校验…" : "绑定"}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="删除 Project"
        description="Project 及其全部会话将被永久删除，此操作不可恢复。"
        size="sm"
      >
        <div className="space-y-5">
          <FieldLabel label={`输入“${project.name}”确认`}>
            <Input value={deleteValue} onChange={(event) => setDeleteValue(event.currentTarget.value)} autoFocus />
          </FieldLabel>
          {mutations.remove.error && (
            <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">
              {errorMessage(mutations.remove.error)}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button onClick={() => setDeleteOpen(false)}>取消</Button>
            <Button
              variant="danger"
              disabled={deleteValue !== project.name || mutations.remove.isPending}
              onClick={() => void remove()}
            >
              {mutations.remove.isPending ? "正在删除…" : "永久删除"}
            </Button>
          </div>
        </div>
      </Dialog>
      <RunnerManagerDialog
        open={runnerManagerOpen}
        onClose={() => setRunnerManagerOpen(false)}
        selectedRunnerId={project.runnerId ?? undefined}
      />
      <RemoteExplorer
        open={workspaceOpen}
        onClose={() => setWorkspaceOpen(false)}
        loadDirectory={loadDirectory}
        mode="directory"
        initialPath={bindWorkspace || undefined}
        selectedPaths={selectedWorkspacePaths}
        onConfirm={(entries) => {
          const selected = entries[0];
          if (selected) bindForm.setValue("workspace", selected.path, { shouldValidate: true });
          setWorkspaceOpen(false);
        }}
        title="选择 workspace"
      />
    </div>
  );
}
