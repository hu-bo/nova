import { ApiError, errorMessage } from '@/api/api-error';
import {
  clearConversationContext,
  deleteConversation,
  listConversationMessages,
  renameConversation,
} from '@/api/generated/conversations';
import type { GetConversationSnapshot200 } from '@/api/generated/projectsAPI.schemas';
import { queryKeys } from '@/api/query-keys';
import { ErrorNotice } from '@/components/error-notice';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { SettingsDialog } from '@/components/ui/settings-dialog';
import { AttachmentImage } from '@/features/attachments';
import { useIdentity } from '@/features/auth';
import { useClientConfig } from '@/features/models';
import {
  RunPanel,
  RunStatus,
  isActiveRun,
  messageView,
  useConversationStream,
  useRunControls,
} from '@/features/runs';
import { usePreferences } from '@/features/settings';
import { Description, Label, ListBox, Popover } from '@heroui/react';
import {
  messageSchema,
  operationsFromMessages,
  type Attachment,
  type Message,
  type ToolOperation,
} from '@nova/agent-ui-contracts';
import type {
  BlockRenderers,
  ChatFeedback,
  ChatMessage,
  MessageListScrollState,
} from '@nova/chat-ui';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  ClipboardList,
  Download,
  Ellipsis,
  FolderKanban,
  MessageCircle,
  Pencil,
  Sparkles,
  Target,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Chat } from './chat-lazy';
import {
  ComposerGoalHeader,
  ComposerModelActions,
  ComposerStartActions,
} from './composer-controls';
import { ComposerUploads } from './conversation-composer';
import { useConversationExport } from './conversation-export';
import {
  ConversationContext,
  ConversationDetailsToggle,
  RunnerBadge,
  UnboundDialog,
} from './conversation.page';
import { useAppendPendingInputMutation } from './conversation.queries';
import { GoalPanel } from './goal-panel';
import { useConversationComposer } from './use-conversation-composer';

const scrollPositions = new Map<string, MessageListScrollState>();

/** SSE 连接状态 → Chat 组件的连接状态。 */
const CHAT_CONNECTION_BY_STREAM_STATE = {
  live: 'open',
  connecting: 'connecting',
  reconnecting: 'reconnecting',
  offline: 'closed',
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

export function ConversationWorkspace({
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

function pauseMessage(reason: string | null): string {
  if (reason === 'RUNNER_OFFLINE')
    return '设备离线，运行已暂停；设备恢复连接后自动继续。已提交的进度保留。';
  return reason ? `任务已暂停（${reason}），已提交的进度保留。` : '任务已暂停，已提交的进度保留。';
}
