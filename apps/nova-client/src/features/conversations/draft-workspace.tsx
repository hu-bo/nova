import { ErrorNotice } from '@/components/error-notice';
import { Button } from '@/components/ui/button';
import { useClientConfig } from '@/features/models';
import { useProjectBinding, useProjectQuery } from '@/features/projects';
import { usePreferences } from '@/features/settings';
import { type Attachment } from '@nova/agent-ui-contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  AlertTriangle,
  Bug,
  ClipboardList,
  FolderKanban,
  GitPullRequest,
  MessageCircle,
  Target,
  Terminal,
} from 'lucide-react';
import { Composer, RemoteExplorer } from './chat-lazy';
import {
  ComposerGoalHeader,
  ComposerModelActions,
  ComposerStartActions,
} from './composer-controls';
import { ComposerUploads } from './conversation-composer';
import { ConversationContext } from './conversation-context';
import { ConversationDetailsToggle } from './conversation-details-toggle';
import { UnboundDialog } from './unbound-dialog';
import { useConversationComposer } from './use-conversation-composer';

export function DraftWorkspace({
  mode,
  projectId,
}: {
  mode: 'chat' | 'project';
  projectId?: string | undefined;
}) {
  const navigate = useNavigate();
  const binding = useProjectBinding(mode === 'project' && projectId ? projectId : null);
  const project = useProjectQuery(projectId ?? null);
  const config = useClientConfig();
  const ctl = useConversationComposer({
    conversationId: null,
    mode,
    projectId,
    binding: mode === 'project' ? (binding.data ?? null) : null,
    isRunning: false,
    pendingInputs: [],
    onCreated: (id) => void navigate({ to: '/conversations/$id', params: { id }, replace: true }),
  });
  const { preferences } = usePreferences();
  const unbound = mode === 'project' && !binding.isPending && !binding.data && !binding.error;
  function start(prompt?: string, plan = false, goal = false) {
    if (plan) ctl.setExecutionMode('plan');
    if (goal) ctl.setGoalArmed(true);
    if (prompt)
      ctl.composer.onTextChange?.(
        ctl.composer.value?.trim() ? ctl.composer.value + '\n\n' + prompt : prompt,
      );
    document
      .querySelector<HTMLTextAreaElement>('.conversation-workspace .nova-composer-textarea')
      ?.focus();
  }
  return (
    <div
      className={
        'conversation-workspace nova-start-workspace grid h-dvh min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-white ' +
        (preferences.contextPanelOpen ? 'xl:grid-cols-[minmax(0,1fr)_280px]' : '')
      }
    >
      <header className="col-span-full flex h-14 min-w-0 items-center justify-between gap-3 border-b border-slate-200 pr-4 pl-16 lg:pl-6">
        <p className="min-w-0 truncate text-sm font-semibold text-slate-800">
          {project.data?.name ? project.data.name + ' / 新会话' : '新会话'}
        </p>
        <ConversationDetailsToggle />
      </header>
      <div className="nova-start-main min-h-0 overflow-y-auto px-5 pb-10 sm:px-8">
        <div className="mx-auto w-full max-w-3xl pt-12 sm:pt-[clamp(3rem,15vh,8rem)]">
          <header className="mb-7 text-center">
            <h1 className="text-2xl font-medium tracking-tight text-slate-800 sm:text-3xl">
              {mode === 'project' ? '一起推进这个项目' : '今天想推进什么？'}
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-500">
              {mode === 'project'
                ? (project.data?.name ?? '项目会话')
                : '从一个问题、一个计划，或一个明确的目标开始。'}
            </p>
          </header>
          <div className="mb-3 flex min-w-0 items-center gap-2 text-xs text-slate-500">
            {projectId ? (
              <Link
                to="/projects/$id"
                params={{ id: projectId }}
                className="flex min-w-0 items-center gap-2 hover:text-accent"
              >
                <FolderKanban size={14} />
                <span className="truncate">{project.data?.name ?? '项目'}</span>
                <span className="truncate text-slate-500">{binding.data?.canonicalCwd}</span>
              </Link>
            ) : (
              <>
                <MessageCircle size={14} />
                <span>新会话</span>
              </>
            )}
            {ctl.selectedRemote && (
              <span className="ml-auto flex min-w-0 items-center gap-1">
                <Terminal size={13} />
                <span className="truncate">{ctl.selectedRemote.name}</span>
              </span>
            )}
          </div>
          {binding.error && (
            <div className="mb-3">
              <ErrorNotice error={binding.error} onRetry={() => void binding.refetch()} />
            </div>
          )}
          {unbound && projectId && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
              <AlertTriangle size={14} />
              先为项目绑定 Runner 或 SSH 远程环境。
              <Link
                to="/projects/$id"
                params={{ id: projectId }}
                className="font-medium text-accent"
              >
                配置项目环境
              </Link>
            </div>
          )}
          <ComposerUploads controller={ctl} />
          <div className="nova-chat">
            <Composer<Attachment>
              {...ctl.composer}
              isRunning={false}
              onSubmit={ctl.submit}
              toolbarStart={<ComposerStartActions controller={ctl} />}
              toolbarEnd={<ComposerModelActions controller={ctl} />}
              headerContent={<ComposerGoalHeader controller={ctl} />}
            />
          </div>
          {ctl.error != null && (
            <div className="mt-3">
              <ErrorNotice error={ctl.error} />
            </div>
          )}
          <div
            className="mx-auto mt-5 flex max-w-2xl flex-wrap justify-center gap-2"
            aria-label="快捷任务"
          >
            <Button
              variant="secondary"
              onPress={() => start('请帮助我理解当前项目的结构、关键模块和工作流程。', true)}
            >
              <FolderKanban size={14} />
              理解项目
            </Button>
            <Button
              variant="secondary"
              onPress={() => start('请先分析需求，制定实现计划，列出关键步骤和验证方式。', true)}
            >
              <ClipboardList size={14} />
              制定计划
            </Button>
            <Button variant="secondary" onPress={() => start('请帮我定位并分析这个问题：')}>
              <Bug size={14} />
              排查问题
            </Button>
            <Button
              variant="secondary"
              onPress={() => start('请审查当前修改，重点检查正确性、边界情况和可维护性。', true)}
            >
              <GitPullRequest size={14} />
              代码审查
            </Button>
            <Button variant="secondary" onPress={() => start(undefined, false, true)}>
              <Target size={14} />
              设定目标
            </Button>
          </div>
          <p className="mt-5 text-center text-[11px] text-slate-500">
            Enter 发送 · Shift+Enter 换行 · /goal 设置目标 · /plan 切换规划
          </p>
          {config.data && !config.data.capabilities.execution && (
            <p role="status" className="mt-3 text-center text-[11px] text-slate-500">
              执行服务待就绪，当前发送会保存消息和所选配置。
            </p>
          )}
          {preferences.contextPanelOpen && (
            <div className="mt-5 rounded-xl border p-4 xl:hidden">
              <ConversationContext controller={ctl} />
            </div>
          )}
          {config.error && (
            <div className="mt-3">
              <ErrorNotice error={config.error} onRetry={() => void config.refetch()} />
            </div>
          )}
        </div>
      </div>
      {preferences.contextPanelOpen && (
        <aside className="hidden min-h-0 overflow-y-auto border-l border-slate-200 p-4 xl:block">
          <ConversationContext controller={ctl} />
        </aside>
      )}
      {ctl.explorerProps && <RemoteExplorer {...ctl.explorerProps} />}
      {ctl.unboundOpen && projectId && (
        <UnboundDialog projectId={projectId} onClose={ctl.closeUnbound} />
      )}
    </div>
  );
}
