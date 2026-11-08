import { ErrorNotice } from '@/components/error-notice';
import { Button } from '@/components/ui/button';
import { useConversationsQuery } from '@/features/conversations';
import { useRemoteConnectionsQuery } from '@/features/remotes';
import { runnerStatus, useRunnersQuery } from '@/features/runners';
import { Link, useParams } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowLeft,
  FolderOpen,
  MessageSquarePlus,
  Pencil,
  Settings2,
} from 'lucide-react';
import { useState } from 'react';
import { DeleteProjectDialog } from './delete-project-dialog';
import { EnvironmentDialog } from './environment-dialog';
import { describeInstructions } from './project.page.shared';
import { useProjectBinding, useProjectQuery } from './project.queries';
import { RenameProjectDialog } from './rename-project-dialog';

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
                {describeInstructions(binding.data.instructions)}
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
