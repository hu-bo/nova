import type { CreateRunnerToken200 } from '@/api/generated/projectsAPI.schemas';
import { createRunnerToken, revokeRunnerToken, rotateRunnerToken } from '@/api/generated/runners';
import { queryKeys } from '@/api/query-keys';
import { ErrorNotice } from '@/components/error-notice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { EmptyState, LoadingState } from '@/components/ui/feedback';
import { SettingsDialog } from '@/components/ui/settings-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useIdentity } from '@/features/auth';
import {
  runnerStatus,
  runnerTokenCanStart,
  useRunnerConnection,
  type Runner,
  type RunnerToken,
} from '@/features/runners';
import { displayWorkspacePath } from '@/lib/workspace-path';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Clipboard, KeyRound, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { CopyButton } from './copy-button';
import { RunnerStartCommandDialog } from './runner-start-command-dialog';
import { RunnerStateBadge } from './runner-state-badge';
import { useRunnerCatalog } from './use-runner-catalog';
import { useRunnerTokens } from './use-runner-tokens';

interface RunnerManagerProps {
  onClose?: () => void;
  selectedRunnerId?: string;
  onSelect?: (runnerId: string) => void | Promise<unknown>;
  /** 会话页入口：选择后由宿主接管（确认旧/新环境、直接切换会话绑定）。 */
  onSelectRequest?: (runnerId: string) => void;
  /** 会话页等嵌入式入口的补充说明：解释「选择」影响哪些会话。 */
  selectionHint?: string;
}

/** Token 预览文本：有密钥时脱敏展示；旧版活跃凭据按能否启动区分；其余视为已失效。 */
function tokenPreviewText(token: RunnerToken): string {
  if (token.token) return '••••••••' + token.token.slice(-6);
  if (token.status === 'active')
    return runnerTokenCanStart(token) ? '旧版凭据 · 轮换后可复制' : 'Token 已过期';
  return 'Token 已失效';
}

/** 「复制 Runner 启动命令」按钮提示：先看凭据能否启动，再区分是否已有可复制的密钥。 */
function copyCommandHint(token: RunnerToken): string {
  if (!runnerTokenCanStart(token)) return '此 Token 已失效';
  if (token.token) return '配置工作目录并复制 Runner 启动命令';
  return '旧版凭据需先轮换一次，生成可复制的 Token';
}

/** Manage Runner credentials, connection commands and registered devices. */
export function RunnerManager({
  onClose,
  selectedRunnerId,
  onSelect,
  onSelectRequest,
  selectionHint,
}: RunnerManagerProps) {
  const { identity } = useIdentity();
  const queryClient = useQueryClient();
  const catalog = useRunnerCatalog();
  const tokens = useRunnerTokens();
  const connection = useRunnerConnection();
  const [deletingToken, setDeletingToken] = useState<RunnerToken | null>(null);
  const [rotatingToken, setRotatingToken] = useState<RunnerToken | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [commandToken, setCommandToken] = useState<RunnerToken | null>(null);
  const [label, setLabel] = useState('');

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.runners.root(identity?.identityId ?? 'anonymous'),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.runners.tokens(identity?.identityId ?? 'anonymous'),
      }),
    ]);

  const createToken = useMutation({
    mutationFn: () => {
      const trimmed = label.trim();
      return createRunnerToken(trimmed ? { label: trimmed } : {});
    },
    onSuccess: async (result: CreateRunnerToken200) => {
      setLabel('');
      setCreating(false);
      setCommandToken(result);
      await refresh();
    },
  });
  const removeToken = useMutation({
    mutationFn: (id: string) => revokeRunnerToken(id),
    onSuccess: async () => {
      setDeletingToken(null);
      await refresh();
    },
  });
  // 创建和轮换后直接用返回的连接 Token 生成启动命令。
  const rotateToken = useMutation({
    mutationFn: (id: string) => rotateRunnerToken(id, { revokePrevious: true }),
    onSuccess: async (result) => {
      setRotatingToken(null);
      setCommandToken(result);
      await refresh();
    },
  });

  const tokenItems = tokens.data;
  // 设备行「复制启动命令」：设备身份由 Runner 本机持久化，任意可用凭据都能让原设备重连。
  const usableCommandToken =
    tokenItems.find((token) => runnerTokenCanStart(token) && token.token) ?? null;

  /** 设备行复制命令按钮提示：先看有没有可用凭据，再区分读取中/需轮换/无有效凭据。 */
  function deviceCommandHint(): string {
    if (tokens.isLoading) return '正在读取凭据…';
    if (usableCommandToken) return '用有效凭据生成启动命令；在该设备上重跑 Runner 会以同一设备身份重连';
    if (tokenItems.some((token) => runnerTokenCanStart(token)))
      return '现有活跃凭据是旧版记录，先轮换一次以生成可复制的 Token';
    return '暂无有效凭据，先「新增 Token」再复制启动命令';
  }

  async function select(runnerId: string) {
    if (!onSelect) return;
    setSelectError(null);
    setSelecting(runnerId);
    try {
      await onSelect(runnerId);
      onClose?.();
    } catch (error) {
      // 绑定失败（如设备没有工作目录、并发修订冲突）留在弹窗内提示，允许换一台再试。
      setSelectError(error);
    } finally {
      setSelecting(null);
    }
  }

  /** Token 区块状态：加载中 → 读取失败 → 空列表 → 凭据卡片。 */
  function renderTokenList() {
    if (tokens.isLoading) return <LoadingState label="正在加载 token" />;
    if (tokens.error)
      return <ErrorNotice error={tokens.error} onRetry={() => void tokens.refetch()} />;
    if (!tokenItems.length)
      return (
        <div className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
          暂无 Runner Token
        </div>
      );
    return (
      <Card className="divide-y divide-slate-100 overflow-hidden">
        {tokenItems.map((token, index) => (
          <div
            key={token.id}
            className="grid gap-3 px-4 py-3 transition hover:bg-slate-50 sm:grid-cols-[minmax(130px,0.6fr)_minmax(180px,1.4fr)_auto] sm:items-center"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500">
                <KeyRound className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <strong className="block text-sm text-slate-900">Token {index + 1}</strong>
                <span className="block truncate text-xs text-slate-500">
                  {token.label ?? '未命名凭据'}
                </span>
              </div>
            </div>
            <code className="block min-w-0 truncate rounded-md bg-slate-100 px-2.5 py-1.5 text-xs text-slate-600">
              {tokenPreviewText(token)}
            </code>
            <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
              <Button
                size="sm"
                variant="outline"
                icon={<Clipboard />}
                disabled={!runnerTokenCanStart(token) || !token.token}
                title={copyCommandHint(token)}
                onPress={() => {
                  setCommandToken(token);
                }}
              >
                复制 Runner 启动命令
              </Button>
              <CopyButton
                value={runnerTokenCanStart(token) ? token.token : null}
                label="复制 Token"
                compact
              />
              {token.status === 'active' && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`轮换 Token ${index + 1}`}
                  title="轮换凭据（旧凭据立即吊销）"
                  disabled={rotateToken.isPending}
                  onPress={() => setRotatingToken(token)}
                >
                  <RefreshCw />
                </Button>
              )}
              {token.status === 'active' && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`撤销 Token ${index + 1}`}
                  onPress={() => setDeletingToken(token)}
                >
                  <Trash2 />
                </Button>
              )}
              {token.status !== 'active' && (
                <Badge
                  variant={token.status === 'revoked' ? 'danger' : 'default'}
                  className="shrink-0 whitespace-nowrap px-2 py-0.5"
                >
                  {token.status === 'revoked' ? '已撤销' : '已轮换'}
                </Badge>
              )}
            </div>
          </div>
        ))}
      </Card>
    );
  }

  // 会话切换门禁：当前绑定设备在线时不允许切走（与服务端 PUT /conversations/:id/binding 同规则）。
  const boundRunner = selectedRunnerId
    ? catalog.runners.find((item) => item.id === selectedRunnerId)
    : undefined;
  const canSwitchConversation = !boundRunner || runnerStatus(boundRunner) !== 'online';

  /** 操作列：复制启动命令让该设备上线；选择入口按会话（宿主接管）或设置（直接）两种契约。 */
  function renderRunnerAction(runner: Runner) {
    const commandButton = (
      <Button
        size="sm"
        variant={selectedRunnerId === runner.id ? 'default' : 'outline'}
        icon={<Clipboard />}
        disabled={!usableCommandToken}
        title={deviceCommandHint()}
        onPress={() => {
          if (usableCommandToken) setCommandToken(usableCommandToken);
        }}
      >
        复制启动命令
      </Button>
    );
    if (selectedRunnerId === runner.id)
      return (
        <>
          {commandButton}
          <Badge variant="primary" className="shrink-0 gap-1 whitespace-nowrap px-2 py-0.5">
            <Check className="size-3 shrink-0" />
            当前
          </Badge>
        </>
      );
    if (!onSelect && !onSelectRequest) return commandButton;
    if (onSelectRequest)
      return (
        <>
          {commandButton}
          <Button
            size="sm"
            variant="outline"
            disabled={!canSwitchConversation}
            title={canSwitchConversation ? '切换本会话与项目到该设备' : '当前绑定设备在线，离线后才能切换'}
            onPress={() => onSelectRequest(runner.id)}
          >
            选择
          </Button>
        </>
      );
    return (
      <>
        {commandButton}
        <Button
          size="sm"
          variant="outline"
          disabled={selecting !== null}
          onPress={() => void select(runner.id)}
        >
          {selecting === runner.id ? '切换中…' : '选择'}
        </Button>
      </>
    );
  }

  /** Runner 区块状态：加载中 → 读取失败 → 空态引导 → 设备表格。 */
  function renderRunnerList() {
    if (catalog.isLoading) return <LoadingState label="正在加载 Runner" />;
    if (catalog.error)
      return <ErrorNotice error={catalog.error} onRetry={() => void catalog.refetch()} />;
    if (!catalog.runners.length)
      return (
        <EmptyState
          icon={<Server />}
          title="还没有 Runner"
          description="点击上方「新增 Token」生成凭据，配置到 Runner 后会自动出现在这里。"
        />
      );
    return (
      <Card className="overflow-hidden">
        <Table className="min-w-[640px] [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2 [&_th]:whitespace-nowrap">
          <TableHeader>
            <TableRow>
              <TableHead>Runner</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>Workspace</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {catalog.runners.map((runner) => (
              <TableRow key={runner.id}>
                <TableCell>
                  <strong className="block max-w-40 truncate text-slate-900" title={runner.id}>
                    {runner.runnerId}
                  </strong>
                  <span className="block max-w-40 truncate text-xs text-slate-500">
                    {runner.capabilities.join(' · ') || '暂未声明能力'}
                  </span>
                </TableCell>
                <TableCell className="w-px whitespace-nowrap">
                  <RunnerStateBadge runner={runner} />
                </TableCell>
                <TableCell>
                  <span
                    className="block max-w-48 truncate text-xs"
                    title={displayWorkspacePath(runner.workspaceId ?? '')}
                  >
                    {displayWorkspacePath(runner.workspaceId ?? '')}
                  </span>
                </TableCell>
                <TableCell className="w-px whitespace-nowrap">
                  <div className="flex items-center justify-end gap-1.5">{renderRunnerAction(runner)}</div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    );
  }

  return (
    <div className="grid gap-8">
      <section aria-labelledby="runner-token-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 id="runner-token-title" className="font-semibold text-slate-900">
              Runner Token
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              生成令牌，复制启动命令，将设备连接到当前账号。
            </p>
          </div>
          <Button
            variant="default"
            icon={<Plus />}
            disabled={createToken.isPending}
            onPress={() => {
              setCreating(true);
              setLabel('');
            }}
          >
            {createToken.isPending ? '创建中…' : '新增 Token'}
          </Button>
        </div>
        {connection.isLoading && (
          <p className="mb-3 text-sm text-slate-500">正在从服务端加载 Runner 连接地址…</p>
        )}
        {connection.error && (
          <div className="mb-3">
            <ErrorNotice error={connection.error} onRetry={() => void connection.refetch()} />
          </div>
        )}
        {renderTokenList()}
      </section>

      <section aria-labelledby="runner-list-title">
        <div className="mb-4">
          <h3 id="runner-list-title" className="font-semibold text-slate-900">
            已注册 Runner
          </h3>
          <p className="mt-1 text-sm text-slate-500">已连接设备的状态和工作目录。</p>
        </div>
        {renderRunnerList()}
        {selectionHint && (
          <p className="mt-3 text-xs leading-5 text-slate-500">{selectionHint}</p>
        )}
        {selectError != null && (
          <div className="mt-3">
            <ErrorNotice error={selectError} />
          </div>
        )}
      </section>

      <SettingsDialog
        open={creating}
        onClose={() => {
          if (!createToken.isPending) {
            setCreating(false);
            setLabel('');
          }
        }}
        title="创建 Runner Token"
        description="为设备起一个便于识别的名字。"
        size="sm"
        icon={<KeyRound />}
        isPending={createToken.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          if (!createToken.isPending) createToken.mutate();
        }}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={createToken.isPending}
              onPress={() => setCreating(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={createToken.isPending}>
              {createToken.isPending ? '创建中…' : '创建'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            <span>凭据名称</span>
            <input
              autoFocus
              maxLength={64}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="例如：办公室电脑"
              className="mt-2 w-full rounded-xl bg-white px-3 py-2.5 text-sm text-slate-900 ring-1 ring-inset ring-slate-200 transition placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-100 disabled:text-slate-500"
            />
          </label>
        </div>
      </SettingsDialog>

      {commandToken && (
        <RunnerStartCommandDialog
          key={commandToken.id}
          token={tokenItems.find((token) => token.id === commandToken.id) ?? commandToken}
          onClose={() => {
            setCommandToken(null);
          }}
        />
      )}

      <ConfirmationDialog
        open={Boolean(rotatingToken)}
        onClose={() => setRotatingToken(null)}
        title="轮换 Runner Token"
        subject={rotatingToken?.label ?? rotatingToken?.id.slice(0, 8)}
        description="旧凭据将立即吊销，使用它的 Runner 会断开。保存新凭据并更新设备配置后即可重连。"
        icon={<RefreshCw />}
        confirmLabel="轮换并吊销旧凭据"
        pendingLabel="轮换中…"
        isPending={rotateToken.isPending}
        error={rotateToken.error}
        onConfirm={() => {
          if (rotatingToken) rotateToken.mutate(rotatingToken.id);
        }}
      />
      <ConfirmationDialog
        open={Boolean(deletingToken)}
        onClose={() => setDeletingToken(null)}
        title="撤销 Runner Token"
        subject={deletingToken?.label ?? deletingToken?.id.slice(0, 8)}
        description="此凭据将失效且无法恢复，使用它的 Runner 需要配置新的 Token 才能连接。"
        confirmLabel="撤销 Token"
        pendingLabel="撤销中…"
        isPending={removeToken.isPending}
        error={removeToken.error}
        onConfirm={() => {
          if (deletingToken) removeToken.mutate(deletingToken.id);
        }}
      />
    </div>
  );
}
