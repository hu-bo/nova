import { ErrorNotice } from '@/components/error-notice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useClientConfig } from '@/features/models';
import { useProjectBinding, useProjectQuery } from '@/features/projects';
import { resolveRemotePath } from '@/features/remotes';
import { runnerStatus, useRunnersQuery } from '@/features/runners';
import { usePreferences } from '@/features/settings';
import { type Attachment } from '@nova/agent-ui-contracts';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  AlertTriangle,
  Bug,
  ClipboardList,
  FolderKanban,
  GitPullRequest,
  MessageCircle,
  PanelRight,
  Target,
  Terminal,
} from 'lucide-react';
import { lazy } from 'react';
import { Composer, RemoteExplorer } from './chat-lazy';
import {
  ComposerGoalHeader,
  ComposerModelActions,
  ComposerStartActions,
} from './composer-controls';
import { ComposerUploads } from './conversation-composer';
import {
  useConversationComposer,
  type ConversationComposerController,
} from './use-conversation-composer';

const RUNNER_BADGE_BY_STATUS = {
  online: { variant: 'success', label: '设备在线' },
  revoked: { variant: 'danger', label: '凭据已撤销' },
  offline: { variant: 'warning', label: '设备未连接' },
} as const;

// 新建会话无需加载历史消息渲染、导出和管理界面。
const ConversationView = lazy(() =>
  import('./conversation-view').then((module) => ({ default: module.ConversationView })),
);

export function ConversationPage() {
  const { id } = useParams({ strict: false }) as { id?: string };
  return id ? <ConversationView key={id} id={id} /> : <NewConversation />;
}

/**
 * 新建会话 —— 参考 `pages/project/new-conversation.tsx` + `pages/conversation.tsx` 草稿模式：
 * 直接进入与正式会话同布局的草稿对话页，首次发送时才创建会话并 replace 跳转到正式 URL。
 * 会话类型由左侧入口决定：普通会话进入无 search 参数的路径，项目会话带 projectId。
 */
function NewConversation() {
  const search = useSearch({ strict: false }) as { projectId?: string };
  return (
    <DraftWorkspace
      key={search.projectId ?? 'chat'}
      mode={search.projectId ? 'project' : 'chat'}
      projectId={search.projectId}
    />
  );
}

export function ConversationDetailsToggle() {
  const { preferences, update } = usePreferences();
  return (
    <Button
      variant="ghost"
      isIconOnly
      aria-label={preferences.contextPanelOpen ? '收起任务详情' : '展开任务详情'}
      title={preferences.contextPanelOpen ? '收起任务详情' : '展开任务详情'}
      aria-pressed={preferences.contextPanelOpen}
      onPress={() => update({ contextPanelOpen: !preferences.contextPanelOpen })}
    >
      <PanelRight size={17} />
    </Button>
  );
}

function DraftWorkspace({
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

export function ConversationContext({
  controller: ctl,
}: {
  controller: ConversationComposerController;
}) {
  const model = ctl.modelProfiles.find((profile) => profile.id === ctl.modelProfileId);
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/40 p-4">
      <h2 className="text-xs font-semibold text-slate-500">会话上下文</h2>
      <dl className="mt-4 space-y-4 text-xs">
        <div>
          <dt className="text-slate-500">模型</dt>
          <dd className="mt-1 break-all font-medium text-slate-700">
            {model?.model ?? '尚未选择模型'}
          </dd>
          {model && <dd className="mt-1 text-slate-500">{model.providerName}</dd>}
        </div>
        <div>
          <dt className="text-slate-500">模式</dt>
          <dd className="mt-1 font-medium text-slate-700">
            {ctl.executionMode === 'plan' ? 'Plan · 只读分析与规划' : 'Build · 推进实现'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">工作环境</dt>
          <dd className="mt-1 break-all text-slate-700">
            {ctl.selectedRemote
              ? ctl.selectedRemote.name + ' · SSH'
              : ctl.binding?.runnerId
                ? '项目 Runner'
                : '普通 Chat'}
          </dd>
          {(ctl.binding || ctl.selectedRemote) && (
            <dd className="mt-1 break-all font-mono leading-5 text-slate-500">
              {ctl.selectedRemote
                ? resolveRemotePath(ctl.selectedRemote.rootPath, ctl.binding?.canonicalCwd)
                : ctl.binding?.canonicalCwd}
            </dd>
          )}
        </div>
      </dl>
      {ctl.goalArmed && (
        <div className="mt-4 border-t border-slate-200 pt-4">
          <p className="flex items-center gap-2 text-xs font-medium text-accent">
            <Target size={14} />
            目标已准备
          </p>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            下一条消息成为目标，最多推进 {ctl.maxIterations} 轮。
          </p>
        </div>
      )}
    </section>
  );
}

/** 项目会话头部的 Runner 状态徽章（参考 `pages/home.tsx` RunnerBadge）。 */
export function RunnerBadge({ runnerId }: { runnerId: string }) {
  const runners = useRunnersQuery();
  const runner = runners.data?.items.find(
    (item) => item.id === runnerId || item.runnerId === runnerId,
  );
  if (runners.isPending) return null;
  const detail = RUNNER_BADGE_BY_STATUS[runner ? runnerStatus(runner) : 'offline'];
  return (
    <Badge variant={detail.variant} className="shrink-0 gap-1 px-2 py-0.5 whitespace-nowrap">
      <span className="size-1.5 shrink-0 rounded-full bg-current" />
      {detail.label}
    </Badge>
  );
}

/** 项目未绑定执行环境时的发送拦截（参考 conversation.tsx L484-502）。 */
export function UnboundDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader icon={<Terminal />}>
          <DialogTitle>先绑定项目环境</DialogTitle>
          <DialogDescription>项目会话需要明确的执行环境后才能处理这条消息。</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm leading-6 text-muted-foreground">
            这条消息尚未发送，草稿已保留。完成项目环境绑定后，回到此会话重新发送；不会降级成普通会话。
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onPress={onClose}>
            先不发送
          </Button>
          <Button onPress={() => void navigate({ to: '/projects/$id', params: { id: projectId } })}>
            去绑定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
