import { Description, Label, ListBox, Popover } from '@heroui/react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  BlockRenderers,
  ChatFeedback,
  ChatMessage,
  MessageListScrollState,
} from '@nova/chat-ui';
import {
  AlertTriangle,
  Bug,
  ClipboardList,
  GitPullRequest,
  Target,
  Terminal,
  Download,
  Ellipsis,
  PanelRight,
  FolderKanban,
  MessageCircle,
  Pencil,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  messageSchema,
  operationsFromMessages,
  type Attachment,
  type Message,
  type ToolOperation,
} from '@nova/agent-ui-contracts';
import { ApiError, errorMessage } from '@/api/api-error';
import {
  clearConversationContext,
  deleteConversation,
  listConversationMessages,
  renameConversation,
} from '@/api/generated/conversations';
import type { GetConversationSnapshot200 } from '@/api/generated/projectsAPI.schemas';
import { queryKeys } from '@/api/query-keys';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogBody,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/feedback';
import { ErrorNotice } from '@/components/error-notice';
import { useIdentity } from '@/features/auth';
import { AttachmentImage } from '@/features/attachments';
import { useProjectBinding, useProjectQuery } from '@/features/projects';
import {
  isActiveRun,
  messageView,
  RunPanel,
  RunStatus,
  useConversationStream,
  useRunControls,
} from '@/features/runs';
import { runnerStatus, useRunnersQuery } from '@/features/runners';
import { useClientConfig } from '@/features/models';
import { resolveRemotePath } from '@/features/remotes';
import { Chat, Composer, RemoteExplorer } from './chat-lazy';
import { ComposerUploads } from './conversation-composer';
import {
  useConversationComposer,
  type ConversationComposerController,
} from './use-conversation-composer';
import {
  ComposerStartActions,
  ComposerModelActions,
  ComposerGoalHeader,
} from './composer-controls';
import { GoalPanel } from './goal-panel';
import { useConversationExport } from './conversation-export';
import { usePreferences } from '@/features/settings';
import { SettingsDialog } from '@/components/ui/settings-dialog';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { useAppendPendingInputMutation, useConversationSnapshot } from './conversation.queries';

const scrollPositions = new Map<string, MessageListScrollState>();

/** SSE 连接状态 → Chat 组件的连接状态。 */
const CHAT_CONNECTION_BY_STREAM_STATE = {
  live: 'open',
  connecting: 'connecting',
  reconnecting: 'reconnecting',
  offline: 'closed',
} as const;
/** RunnerBadge 的状态徽章呈现（文案为会话页专用）。 */
const RUNNER_BADGE_BY_STATUS = {
  online: { variant: 'success', label: '设备在线' },
  revoked: { variant: 'danger', label: '凭据已撤销' },
  offline: { variant: 'warning', label: '设备未连接' },
} as const;

/** 已保存消息 → 聊天视图消息（系统消息等无视图形态的会被过滤掉）。 */
function toMessageViews(
  messages: readonly Message[],
  conversationId: string,
  operations: ToolOperation[],
): ChatMessage[] {
  return messages.flatMap((message) => {
    const view = messageView(message, conversationId, operations);
    return view ? [view] : [];
  });
}

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

function ConversationDetailsToggle() {
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

function ConversationContext({ controller: ctl }: { controller: ConversationComposerController }) {
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

function ConversationView({ id }: { id: string }) {
  const { identity } = useIdentity();
  const client = useQueryClient();
  const snapshot = useConversationSnapshot(id);
  const stream = useConversationStream(id, snapshot.data);
  useEffect(() => {
    if (snapshot.error instanceof ApiError && [403, 404].includes(snapshot.error.status)) {
      stream.forget();
      void client.invalidateQueries({
        queryKey: queryKeys.conversations.list(identity!.identityId, { limit: 100 }),
      });
    }
    // Resource disappearance should release its stream once, without requesting it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.error, client, identity, id]);
  if (snapshot.isPending)
    return (
      <div
        role="status"
        className="grid min-h-[60vh] place-items-center text-sm text-muted-foreground"
      >
        正在打开会话…
      </div>
    );
  if (snapshot.error)
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <Link to="/conversations" className="text-sm text-accent">
          返回会话列表
        </Link>
        <ErrorNotice error={snapshot.error} onRetry={() => void snapshot.refetch()} />
      </div>
    );
  return <ConversationWorkspace id={id} data={snapshot.data} stream={stream} />;
}

function ConversationWorkspace({
  id,
  data,
  stream,
}: {
  id: string;
  data: GetConversationSnapshot200;
  stream: ReturnType<typeof useConversationStream>;
}) {
  const { identity } = useIdentity();
  const client = useQueryClient();
  const navigate = useNavigate();
  const config = useClientConfig();
  const controls = useRunControls(stream);
  const { preferences, update } = usePreferences();
  const exportHistory = useConversationExport(id, identity!.identityId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<'rename' | 'delete' | 'clear' | null>(null);
  const [title, setTitle] = useState('');
  const [clearNotice, setClearNotice] = useState<string | null>(null);
  const projection = stream.projection;
  const pendingInputs = projection?.pendingInputs ?? data.pendingInputs;
  const runState = projection?.run?.state ?? data.run?.state;
  const pauseReason = projection?.run?.reason ?? data.run?.reason ?? null;
  const active = isActiveRun(runState);
  const executionEnabled = Boolean(config.data?.capabilities.execution);
  const maintenanceLocked = active || runState === 'cancelled_unconfirmed';
  // 首屏自动加载第一页历史；「加载更早的消息」继续向前翻页。
  const history = useInfiniteQuery({
    queryKey: queryKeys.conversations.history(identity!.identityId, id),
    enabled: Boolean(data.beforeSequence),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const before = pageParam ?? data.beforeSequence;
      return listConversationMessages(id, before ? { before } : {}, { signal });
    },
    getNextPageParam: (page) => page.beforeSequence ?? undefined,
  });
  const edit = useMutation({
    mutationFn: async () => {
      if (dialog === 'rename') {
        if (!title.trim() || title.trim().length > 200)
          throw new ApiError(400, 400, '标题需要 1–200 个字符。');
        await renameConversation(id, { title: title.trim() });
      } else if (dialog === 'delete') await deleteConversation(id);
      else if (dialog === 'clear') await clearConversationContext(id, {});
    },
    onSuccess: async () => {
      if (dialog === 'delete') {
        stream.forget();
        client.removeQueries({
          queryKey: queryKeys.conversations.snapshot(identity!.identityId, id),
        });
        void navigate({ to: '/conversations' });
      }
      if (dialog === 'clear') setClearNotice('上下文已清除；历史消息仍保留在当前会话中。');
      await client.invalidateQueries({
        queryKey: queryKeys.conversations.root(identity!.identityId),
      });
      setDialog(null);
    },
  });
  const ctl = useConversationComposer({
    conversationId: id,
    mode: data.conversation.mode,
    projectId: data.conversation.projectId ?? undefined,
    binding: data.binding,
    runtime: data.conversation.configuration,
    goal: projection?.goal ?? data.goal,
    isRunning: active,
    steeringEnabled:
      executionEnabled && (projection?.data.capabilities ?? data.capabilities).steering,
    pendingInputs,
    contextUsage: projection?.usage,
    onClearContext: () => {
      edit.reset();
      setDialog('clear');
    },
  });
  const retryAppend = useAppendPendingInputMutation(id);
  const savedMessages = useMemo(
    () => data.messages.map((message) => messageSchema.parse(message)),
    [data.messages],
  );
  const olderMessages = useMemo(
    () =>
      history.data?.pages
        .slice()
        .reverse()
        .flatMap((page) => page.items.map((message) => messageSchema.parse(message))) ?? [],
    [history.data],
  );
  const rawMessages = useMemo(
    () => [...olderMessages, ...(projection?.data.messages ?? savedMessages)],
    [olderMessages, projection?.data.messages, savedMessages],
  );
  const historicalOperations = useMemo(
    () => operationsFromMessages(rawMessages, projection?.data.operations ?? data.operations),
    [rawMessages, projection?.data.operations, data.operations],
  );
  const currentMessages =
    projection?.messages ?? toMessageViews(savedMessages, id, historicalOperations);
  const older = toMessageViews(olderMessages, id, historicalOperations);
  const ids = new Set(currentMessages.map((message) => message.id));
  const messages = [...older.filter((message) => !ids.has(message.id)), ...currentMessages];
  const todos = projection?.todos ?? data.plan ?? [];
  const pageCursor = history.data ? history.hasNextPage : Boolean(data.beforeSequence);
  const canAbort = active && executionEnabled && controls.canCancel;
  const onAbort = canAbort ? () => controls.cancel.mutate() : undefined;
  const renderers = useMemo<BlockRenderers>(
    () => ({
      image: ({ block }) =>
        block.type === 'image' && block.reference ? (
          <AttachmentImage reference={block.reference} name={block.name} />
        ) : null,
    }),
    [],
  );
  // 失败重试：从失败消息回溯最近的用戶消息，用原始文本 + 附件重新排队（参考 mutations.retry）。
  function retryMessage(messageId: string) {
    const index = messages.findIndex((message) => message.id === messageId);
    const failed = index >= 0 ? messages[index] : undefined;
    let user: ChatMessage | undefined = failed?.role === 'user' ? failed : undefined;
    if (!user)
      for (let i = (index < 0 ? messages.length : index) - 1; i >= 0; i -= 1)
        if (messages[i]!.role === 'user') {
          user = messages[i];
          break;
        }
    if (!user) return;
    const raw = rawMessages.find((message) => message.id === user!.id);
    const blocks = raw?.blocks.filter(
      (block) => block.type === 'text' || block.type === 'image' || block.type === 'file',
    );
    if (!blocks?.length) return;
    retryAppend.mutate({ blocks, mode: 'next_run' });
  }
  const feedback: ChatFeedback[] = [];
  if (ctl.error && !(ctl.error instanceof ApiError && ctl.error.notified))
    feedback.push({ id: 'composer', message: errorMessage(ctl.error), tone: 'error' });
  if (clearNotice)
    feedback.push({ id: 'clear-notice', message: clearNotice, tone: 'info', dismissible: true });
  const connection = CHAT_CONNECTION_BY_STREAM_STATE[stream.state];
  return (
    <div className="conversation-workspace flex h-dvh min-h-0 flex-col">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-slate-200 pr-4 pl-16 text-xs text-slate-500 lg:pl-6">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 py-1">
          <h1 className="min-w-0 max-w-full truncate text-sm font-semibold text-slate-800">
            {data.conversation.title || '未命名会话'}
          </h1>
          {data.binding?.runnerId && (
            <span className="hidden sm:block">
              <RunnerBadge runnerId={data.binding.runnerId} />
            </span>
          )}
          {todos.length > 0 && (
            <Button variant="ghost" size="xs" onPress={() => update({ contextPanelOpen: true })}>
              <ClipboardList size={13} />
              计划 {todos.filter((item) => item.status === 'completed').length}/{todos.length}
            </Button>
          )}
          {exportHistory.count !== null && (
            <span role="status">正在导出 {exportHistory.count} 条消息…</span>
          )}
          {ctl.goal && (
            <Button
              variant="ghost"
              size="xs"
              onPress={() => ctl.setGoalDialogOpen(true)}
              aria-label="查看当前目标"
            >
              <Target size={13} />
              目标{' '}
              {
                { ready: '待推进', active: '推进中', paused: '已暂停', completed: '已完成' }[
                  ctl.goal.status
                ]
              }{' '}
              · {ctl.goal.iterations ?? 0}/{ctl.goal.maxIterations ?? 10}
            </Button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <RunStatus
            stream={stream}
            controls={controls}
            onRetry={stream.retry}
            executionEnabled={executionEnabled}
          />
          <ConversationDetailsToggle />
          <Popover isOpen={menuOpen} onOpenChange={setMenuOpen}>
            <Button variant="ghost" isIconOnly aria-label="会话操作">
              <Ellipsis size={17} />
            </Button>
            <Popover.Content placement="bottom end">
              <Popover.Dialog>
                <ListBox
                  aria-label="会话操作"
                  selectionMode="none"
                  disabledKeys={[
                    ...(maintenanceLocked ? ['clear', 'delete'] : []),
                    ...(exportHistory.count !== null ? ['export'] : []),
                  ]}
                  onAction={(key) => {
                    setMenuOpen(false);
                    if (key === 'export') {
                      void exportHistory.start();
                      return;
                    }
                    edit.reset();
                    if (key === 'rename') setTitle(data.conversation.title ?? '');
                    if (key === 'rename' || key === 'clear' || key === 'delete') setDialog(key);
                  }}
                >
                  <ListBox.Item id="rename" textValue="重命名会话">
                    <Pencil size={15} />
                    <Label>重命名会话</Label>
                  </ListBox.Item>
                  <ListBox.Item id="export" textValue="导出 Markdown">
                    <Download size={15} />
                    <div>
                      <Label>导出 Markdown</Label>
                      <Description>包含完整已保存历史</Description>
                    </div>
                  </ListBox.Item>
                  <ListBox.Item id="clear" textValue="清空上下文">
                    <Sparkles size={15} />
                    <div>
                      <Label>清空上下文</Label>
                      <Description>保留消息历史</Description>
                    </div>
                  </ListBox.Item>
                  <ListBox.Item id="delete" textValue="删除会话" variant="danger">
                    <Trash2 size={15} />
                    <Label>删除会话</Label>
                  </ListBox.Item>
                </ListBox>
              </Popover.Dialog>
            </Popover.Content>
          </Popover>
        </div>
      </header>
      <div className="max-h-[35vh] shrink-0 overflow-y-auto">
        <RunPanel stream={stream} controls={controls} onRetry={stream.retry} />
      </div>
      {exportHistory.error != null && <ErrorNotice error={exportHistory.error} />}
      {config.error && <ErrorNotice error={config.error} onRetry={() => void config.refetch()} />}
      {runState === 'paused' && (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <p className="min-w-0 flex-1">{pauseMessage(pauseReason)}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={!canAbort}
            onPress={() => controls.cancel.mutate()}
          >
            停止任务
          </Button>
        </div>
      )}
      {pageCursor && (
        <div className="shrink-0 text-center">
          <Button
            variant="ghost"
            size="sm"
            disabled={history.isFetching}
            onPress={() => void history.fetchNextPage()}
          >
            {history.isFetching ? '正在加载历史…' : '加载更早的消息'}
          </Button>
        </div>
      )}
      {history.error && (
        <ErrorNotice error={history.error} onRetry={() => void history.fetchNextPage()} />
      )}
      <ComposerUploads controller={ctl} />
      <Chat<Attachment>
        sidebarOpen={preferences.contextPanelOpen}
        initialScrollState={scrollPositions.get(`${identity!.identityId}:${id}`)}
        state={{
          messages,
          todos,
          queuedMessages: ctl.queuedMessages,
          pendingDecision: controls.request,
          connection,
          isRunning: active,
          isAborting: controls.cancelling,
          isResolvingDecision: controls.resolve.isPending || controls.resolve.isSuccess,
          isSteeringQueuedMessage: ctl.isSteering,
          feedback,
        }}
        composer={{
          ...ctl.composer,
          toolbarStart: <ComposerStartActions controller={ctl} />,
          toolbarEnd: <ComposerModelActions controller={ctl} />,
          headerContent: <ComposerGoalHeader controller={ctl} />,
        }}
        sidebar={
          <div className="space-y-3">
            <ConversationContext controller={ctl} />
            {data.goal && <GoalPanel conversationId={id} goal={data.goal} running={active} />}
          </div>
        }
        actions={{
          onScrollStateChange: (state) => {
            scrollPositions.set(`${identity!.identityId}:${id}`, state);
            if (scrollPositions.size > 100)
              scrollPositions.delete(scrollPositions.keys().next().value!);
          },
          onSubmit: ctl.submit,
          ...(onAbort ? { onAbort } : {}),
          onRetryMessage: retryMessage,
          onResolveDecision: (response) =>
            controls.resolve
              .mutateAsync(response)
              .then(() => undefined)
              .catch(() => undefined),
          onRemoveQueuedMessage: ctl.removeQueued,
          onSteerQueuedMessage: ctl.steerQueued,
          onDismissFeedback: (feedbackId) => {
            if (feedbackId === 'clear-notice') setClearNotice(null);
          },
        }}
        emptyState={
          <EmptyState
            icon={
              data.conversation.mode === 'project' ? (
                <FolderKanban className="size-5" aria-hidden="true" />
              ) : (
                <MessageCircle className="size-5" aria-hidden="true" />
              )
            }
            title={
              data.conversation.mode === 'project' ? '告诉 Agent 想完成的目标' : '从一个问题开始'
            }
            description={
              data.conversation.mode === 'project'
                ? `Agent 将在 ${data.binding ? data.binding.canonicalCwd : '项目工作目录'} 中工作，过程会实时显示在这里。`
                : '可以讨论方案、分析代码或制定多步计划。'
            }
          />
        }
        renderers={renderers}
        explorer={ctl.explorerProps}
      />
      {ctl.unboundOpen && data.conversation.projectId && (
        <UnboundDialog projectId={data.conversation.projectId} onClose={ctl.closeUnbound} />
      )}
      <SettingsDialog
        open={ctl.goalDialogOpen}
        onClose={() => ctl.setGoalDialogOpen(false)}
        title="会话目标"
        size="sm"
      >
        {data.goal && <GoalPanel conversationId={id} goal={data.goal} running={active} />}
      </SettingsDialog>
      <ConfirmationDialog
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        title="删除会话"
        subject={data.conversation.title || '未命名会话'}
        description="消息历史和附件预览引用将被删除，删除后无法恢复。设备上的文件会保留。"
        confirmLabel="删除会话"
        pendingLabel="正在删除…"
        isPending={edit.isPending}
        error={edit.error}
        onConfirm={() => edit.mutate()}
      />
      {dialog && dialog !== 'delete' && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          isPending={edit.isPending}
        >
          <DialogContent closeDisabled={edit.isPending}>
            <form
              className="flex min-h-0 flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                edit.mutate();
              }}
            >
              <DialogHeader icon={dialog === 'rename' ? <Pencil /> : <Sparkles />}>
                <DialogTitle>{dialog === 'rename' ? '重命名会话' : '清空上下文'}</DialogTitle>
                <DialogDescription>
                  {dialog === 'clear'
                    ? '当前计划会清零，后续运行从新的上下文开始。历史消息仍可阅读。'
                    : '为这段会话设置一个清楚的标题。'}
                </DialogDescription>
              </DialogHeader>
              <DialogBody className="space-y-3">
                {dialog === 'rename' && (
                  <Input
                    autoFocus
                    aria-label="会话标题"
                    value={title}
                    maxLength={200}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                )}
                {edit.error && <ErrorNotice error={edit.error} />}
              </DialogBody>
              <DialogFooter>
                <Button variant="ghost" disabled={edit.isPending} onPress={() => setDialog(null)}>
                  取消
                </Button>
                <Button type="submit" variant="default" disabled={edit.isPending}>
                  {edit.isPending ? '正在处理…' : dialog === 'rename' ? '保存标题' : '清空上下文'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** 项目会话头部的 Runner 状态徽章（参考 `pages/home.tsx` RunnerBadge）。 */
function RunnerBadge({ runnerId }: { runnerId: string }) {
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
function UnboundDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
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

function pauseMessage(reason: string | null): string {
  if (reason === 'RUNNER_OFFLINE')
    return '设备离线，运行已暂停；设备恢复连接后自动继续。已提交的进度保留。';
  return reason ? `任务已暂停（${reason}），已提交的进度保留。` : '任务已暂停，已提交的进度保留。';
}
