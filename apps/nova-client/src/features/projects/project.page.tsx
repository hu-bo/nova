import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  FolderOpen,
  MessageSquarePlus,
  Pencil,
  Settings2,
} from 'lucide-react';
import { bindProjectEnvironment, deleteProject, updateProject } from '@/api/generated/projects';
import type { GetProjectBinding200 } from '@/api/generated/projectsAPI.schemas';
import { queryKeys } from '@/api/query-keys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogBody,
} from '@/components/ui/dialog';
import { ErrorNotice } from '@/components/error-notice';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { useIdentity } from '@/features/auth';
import { useConversationsQuery } from '@/features/conversations';
import { useRunnersQuery, runnerStatus } from '@/features/runners';
import { useModelSettings } from '@/features/settings';
import { useProjectBinding, useProjectQuery } from './project.queries';
import { useRemoteConnectionsQuery } from '@/features/remotes';
import { ProjectEnvironmentPicker } from './project-environment-picker';
import {
  useProjectEnvironmentRequest,
  validWorkspacePath,
  type ProjectEnvironment,
} from './project-environment';

export function ProjectPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const project = useProjectQuery(id);
  const binding = useProjectBinding(id);
  const conversations = useConversationsQuery({ limit: 100 });
  const runners = useRunnersQuery();
  const remotes = useRemoteConnectionsQuery();
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (project.isPending)
    return (
      <p role="status" className="p-8 text-sm text-muted-foreground">
        正在加载项目…
      </p>
    );
  if (project.error)
    return <ErrorNotice error={project.error} onRetry={() => void project.refetch()} />;
  const related =
    conversations.data?.items.filter((conversation) => conversation.projectId === id) ?? [];
  // 绑定的设备离线/撤销时给出琥珀横幅（参考 projects/project.tsx RunnerOffline 提示）。
  const boundRunner = binding.data
    ? runners.data?.items.find(
        (runner) =>
          runner.id === binding.data!.runnerId || runner.runnerId === binding.data!.runnerId,
      )
    : undefined;
  const runnerOffline =
    Boolean(binding.data?.runnerId) &&
    !runners.isPending &&
    (!boundRunner || runnerStatus(boundRunner) !== 'online');
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-5 py-8 sm:px-8">
      <Link
        to="/projects"
        className="ml-10 inline-flex items-center gap-2 text-xs text-muted-foreground lg:ml-0"
      >
        <ArrowLeft size={14} />
        返回项目
      </Link>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0">
            <p className="text-xs text-accent">项目空间</p>
            <h1 className="mt-2 break-words text-2xl font-semibold">{project.data.name}</h1>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="重命名项目"
            className="mt-2"
            onPress={() => setRenaming(true)}
          >
            <Pencil size={15} />
          </Button>
        </div>
        <Link
          to="/conversations"
          search={{ projectId: id }}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground"
        >
          <MessageSquarePlus size={16} />
          新建项目会话
        </Link>
      </header>
      {runnerOffline && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
          绑定的设备当前未连接，项目会话发出的任务会排队等待设备上线。
          <Link to="/settings/runners" className="underline">
            查看设备
          </Link>
        </p>
      )}
      <section className="rounded-2xl border bg-surface p-5 sm:p-6">
        <header className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <FolderOpen size={17} className="text-accent" />
            执行环境与指令
          </h2>
          <Button variant="outline" disabled={binding.isPending} onPress={() => setEditing(true)}>
            <Settings2 size={15} />
            配置环境
          </Button>
        </header>
        {binding.error ? (
          <div className="mt-4">
            <ErrorNotice error={binding.error} onRetry={() => void binding.refetch()} />
          </div>
        ) : binding.isPending ? (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            正在加载环境…
          </p>
        ) : binding.data ? (
          <div className="mt-5 space-y-4">
            <dl className="grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">设备</dt>
                <dd className="mt-1 break-all font-mono text-xs">
                  {binding.data.remoteConnectionId
                    ? (remotes.data?.items.find(
                        (item) => item.id === binding.data?.remoteConnectionId,
                      )?.name ?? 'SSH 远程')
                    : (boundRunner?.runnerId ?? binding.data.runnerId)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">工作目录</dt>
                <dd className="mt-1 break-all">{binding.data.canonicalCwd}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">环境版本</dt>
                <dd className="mt-1">{binding.data.revision}</dd>
              </div>
            </dl>
            <div className="border-t pt-4">
              <p className="mb-2 text-xs text-muted-foreground">项目指令</p>
              <p className="whitespace-pre-wrap break-words text-sm leading-6">
                {binding.data.instructions.customPrompt || '未配置自定义指令'}
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-5 rounded-xl border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">
              选择 Runner 或 SSH 工作目录，再开启项目会话。
            </p>
            <Button className="mt-4" onPress={() => setEditing(true)}>
              绑定环境
            </Button>
          </div>
        )}
        <p className="mt-5 text-xs leading-5 text-muted-foreground">
          环境更新后，新会话采用新配置；已有会话保留原来的设备、目录和指令。
        </p>
      </section>
      <section className="rounded-2xl border bg-surface p-5 sm:p-6">
        <h2 className="text-sm font-semibold">项目会话</h2>
        {conversations.error ? (
          <div className="mt-3">
            <ErrorNotice error={conversations.error} onRetry={() => void conversations.refetch()} />
          </div>
        ) : (
          <ul className="mt-3 divide-y">
            {related.map((conversation) => (
              <li key={conversation.id}>
                <Link
                  to="/conversations/$id"
                  params={{ id: conversation.id }}
                  className="flex items-center justify-between gap-3 py-4 text-sm hover:text-accent"
                >
                  <span className="truncate">{conversation.title ?? '未命名会话'}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {conversation.activeRunId
                      ? '运行中'
                      : new Date(conversation.updatedAt).toLocaleDateString('zh-CN')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {!related.length && !conversations.error && (
          <p className="mt-4 text-sm text-muted-foreground">这个项目还没有会话。</p>
        )}
      </section>
      <section className="rounded-2xl border border-danger/30 bg-surface p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-danger">危险操作</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          删除后项目从列表消失，环境绑定失效；已有会话历史与设备上的文件不会被删除。
        </p>
        <Button variant="danger" className="mt-4" onPress={() => setDeleting(true)}>
          删除项目
        </Button>
      </section>
      {editing && (
        <EnvironmentDialog
          projectId={id}
          binding={binding.data ?? null}
          onClose={() => setEditing(false)}
        />
      )}
      {renaming && (
        <RenameProjectDialog
          projectId={id}
          name={project.data.name}
          onClose={() => setRenaming(false)}
        />
      )}
      {deleting && (
        <DeleteProjectDialog
          projectId={id}
          name={project.data.name}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  );
}
function RenameProjectDialog({
  projectId,
  name,
  onClose,
}: {
  projectId: string;
  name: string;
  onClose: () => void;
}) {
  const { identity } = useIdentity();
  const client = useQueryClient();
  const [next, setNext] = useState(name);
  const save = useMutation({
    mutationFn: () => updateProject(projectId, { name: next.trim() }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.projects.root(identity!.identityId) });
      onClose();
    },
  });
  const valid = next.trim().length > 0 && next.trim().length <= 200;
  return (
    <Dialog
      open
      isPending={save.isPending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent closeDisabled={save.isPending}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <DialogHeader icon={<Pencil />}>
            <DialogTitle>重命名项目</DialogTitle>
            <DialogDescription>为这个项目设置一个清楚的名字。</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <Input
              autoFocus
              aria-label="项目名称"
              value={next}
              maxLength={200}
              onChange={(event) => setNext(event.target.value)}
            />
            {save.error && <ErrorNotice error={save.error} />}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={save.isPending} onPress={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={save.isPending || !valid}>
              {save.isPending ? '正在保存…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function DeleteProjectDialog({
  projectId,
  name,
  onClose,
}: {
  projectId: string;
  name: string;
  onClose: () => void;
}) {
  const { identity } = useIdentity();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState('');
  const remove = useMutation({
    mutationFn: () => deleteProject(projectId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.projects.root(identity!.identityId) });
      void navigate({ to: '/projects' });
    },
  });
  return (
    <ConfirmationDialog
      open
      onClose={onClose}
      title="删除项目"
      subject={name}
      description="项目将从列表移除，环境绑定会失效；已有会话历史与设备文件会保留。"
      confirmLabel="删除项目"
      pendingLabel="正在删除…"
      isPending={remove.isPending}
      confirmDisabled={confirm.trim() !== name}
      error={remove.error}
      onConfirm={() => {
        if (confirm.trim() === name && !remove.isPending) remove.mutate();
      }}
    >
      <div className="space-y-2">
        <label htmlFor="delete-project-name" className="text-sm font-medium">
          输入项目名称以确认
        </label>
        <Input
          id="delete-project-name"
          autoFocus
          disabled={remove.isPending}
          value={confirm}
          autoComplete="off"
          placeholder={name}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>
    </ConfirmationDialog>
  );
}

function EnvironmentDialog({
  projectId,
  binding,
  onClose,
}: {
  projectId: string;
  binding: GetProjectBinding200 | null;
  onClose: () => void;
}) {
  const { identity } = useIdentity();
  const client = useQueryClient();
  const settings = useModelSettings();
  const [environment, setEnvironment] = useState<ProjectEnvironment>({
    target: binding?.remoteConnectionId
      ? 'ssh:' + binding.remoteConnectionId
      : binding?.runnerId
        ? 'runner:' + binding.runnerId
        : settings.defaultRunnerId
          ? 'runner:' + settings.defaultRunnerId
          : '',
    canonicalCwd: binding?.canonicalCwd ?? '.',
  });
  const [customPrompt, setCustomPrompt] = useState(binding?.instructions.customPrompt ?? '');
  const { request } = useProjectEnvironmentRequest(environment);
  const save = useMutation({
    mutationFn: () => {
      if (!request) throw new Error('请选择有效的运行环境。');
      return bindProjectEnvironment(projectId, {
        ...request,
        customPrompt,
        expectedRevision: binding?.revision ?? 0,
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.projects.root(identity!.identityId) });
      onClose();
    },
    onError: () =>
      client.invalidateQueries({ queryKey: queryKeys.projects.root(identity!.identityId) }),
  });
  return (
    <Dialog
      open
      isPending={save.isPending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent closeDisabled={save.isPending}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (request && validWorkspacePath(environment.canonicalCwd, environment.target))
              save.mutate();
          }}
        >
          <DialogHeader icon={<Settings2 />}>
            <DialogTitle>配置项目环境</DialogTitle>
            <DialogDescription>
              选择工作目录，设置项目指令。已有会话保留创建时的环境。
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            <ProjectEnvironmentPicker value={environment} onChange={setEnvironment} />
            <div>
              <label htmlFor="project-instructions" className="mb-2 block text-sm font-medium">
                项目指令
              </label>
              <Textarea
                id="project-instructions"
                value={customPrompt}
                rows={5}
                maxLength={32000}
                onChange={(event) => setCustomPrompt(event.target.value)}
                placeholder="例如：使用 TypeScript，遵守仓库约定。"
              />
            </div>
            {save.error && <ErrorNotice error={save.error} />}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={save.isPending} onPress={onClose}>
              取消
            </Button>
            <Button
              type="submit"
              disabled={
                save.isPending ||
                !request ||
                !validWorkspacePath(environment.canonicalCwd, environment.target)
              }
            >
              {save.isPending ? '正在保存…' : '保存环境'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
