import { Check, Clipboard, KeyRound, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SettingsDialog } from '@/components/ui/settings-dialog';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { LoadingState, EmptyState } from '@/components/ui/feedback';
import { ErrorNotice } from '@/components/error-notice';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { createRunnerToken, revokeRunnerToken, rotateRunnerToken } from '@/api/generated/runners';
import type { CreateRunnerToken200 } from '@/api/generated/projectsAPI.schemas';
import { runnerStatus, type Runner, type RunnerToken } from '@/features/runners';
import { displayWorkspacePath } from '@/lib/workspace-path';
import { queryKeys } from '@/api/query-keys';
import { useIdentity } from '@/features/auth';
import { useRunnerCatalog } from './use-runner-catalog';
import { useRunnerConnection } from '@/features/runners';
import { useRunnerTokens } from './use-runner-tokens';
import { runnerTokenCanStart } from '@/features/runners';
import { RunnerStartCommandDialog } from './runner-start-command-dialog';

interface RunnerManagerDialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  selectedRunnerId?: string;
  onSelect?: (runnerId: string) => void;
}

interface RunnerManagerProps {
  onClose?: () => void;
  selectedRunnerId?: string;
  onSelect?: (runnerId: string) => void;
}

/** Manage Runner credentials, connection commands and registered devices. */
export function RunnerManager({ onClose, selectedRunnerId, onSelect }: RunnerManagerProps) {
  const { identity } = useIdentity();
  const queryClient = useQueryClient();
  const catalog = useRunnerCatalog();
  const tokens = useRunnerTokens();
  const connection = useRunnerConnection();
  const [deletingToken, setDeletingToken] = useState<RunnerToken | null>(null);
  const [rotatingToken, setRotatingToken] = useState<RunnerToken | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
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

  async function select(runnerId: string) {
    if (!onSelect) return;
    setSelecting(runnerId);
    try {
      await onSelect(runnerId);
      onClose?.();
    } finally {
      setSelecting(null);
    }
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
        {tokens.isLoading ? (
          <LoadingState label="正在加载 token" />
        ) : tokens.error ? (
          <ErrorNotice error={tokens.error} onRetry={() => void tokens.refetch()} />
        ) : !tokenItems.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
            暂无 Runner Token
          </div>
        ) : (
          <Card className="divide-y divide-slate-100 overflow-hidden">
            {tokenItems.map((token, index) => (
              <div
                key={token.id}
                className="grid gap-3 px-4 py-3 transition hover:bg-slate-50 sm:grid-cols-[minmax(130px,0.6fr)_minmax(180px,1.4fr)_auto] sm:items-center"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500">
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
                  {token.token
                    ? '••••••••' + token.token.slice(-6)
                    : token.status === 'active'
                      ? runnerTokenCanStart(token)
                        ? '旧版凭据 · 轮换后可复制'
                        : 'Token 已过期'
                      : 'Token 已失效'}
                </code>
                <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<Clipboard />}
                    disabled={!runnerTokenCanStart(token) || !token.token}
                    title={
                      runnerTokenCanStart(token)
                        ? token.token
                          ? '配置工作目录并复制 Runner 启动命令'
                          : '旧版凭据需先轮换一次，生成可复制的 Token'
                        : '此 Token 已失效'
                    }
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
        )}
      </section>

      <section aria-labelledby="runner-list-title">
        <div className="mb-4">
          <h3 id="runner-list-title" className="font-semibold text-slate-900">
            已注册 Runner
          </h3>
          <p className="mt-1 text-sm text-slate-500">已连接设备的状态和工作目录。</p>
        </div>
        {catalog.isLoading ? (
          <LoadingState label="正在加载 Runner" />
        ) : catalog.error ? (
          <ErrorNotice error={catalog.error} onRetry={() => void catalog.refetch()} />
        ) : !catalog.runners.length ? (
          <EmptyState
            icon={<Server />}
            title="还没有 Runner"
            description="点击上方「新增 Token」生成凭据，配置到 Runner 后会自动出现在这里。"
          />
        ) : (
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
                      <div className="flex items-center justify-end gap-1.5">
                        {onSelect &&
                          (selectedRunnerId === runner.id ? (
                            <Badge
                              variant="primary"
                              className="shrink-0 gap-1 whitespace-nowrap px-2 py-0.5"
                            >
                              <Check className="size-3 shrink-0" />
                              当前
                            </Badge>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={selecting !== null}
                              onPress={() => void select(runner.id)}
                            >
                              {selecting === runner.id ? '切换中…' : '选择'}
                            </Button>
                          ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
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

export function RunnerManagerDialog({
  open,
  onClose,
  title = 'Runner 与连接令牌',
  selectedRunnerId,
  onSelect,
}: RunnerManagerDialogProps) {
  return (
    <SettingsDialog open={open} onClose={onClose} size="xl" title={title}>
      <RunnerManager
        onClose={onClose}
        {...(selectedRunnerId ? { selectedRunnerId } : {})}
        {...(onSelect ? { onSelect } : {})}
      />
    </SettingsDialog>
  );
}

function RunnerStateBadge({ runner }: { runner: Runner }) {
  const status = runnerStatus(runner);
  const variant = status === 'online' ? 'success' : status === 'revoked' ? 'danger' : 'warning';
  const label = status === 'online' ? '在线' : status === 'revoked' ? '已撤销' : '离线';
  return (
    <Badge variant={variant} className="shrink-0 gap-1 whitespace-nowrap px-2 py-0.5">
      <span className="size-1.5 shrink-0 rounded-full bg-current" />
      {label}
    </Badge>
  );
}

function CopyButton({
  value,
  label,
  compact = false,
}: {
  value: string | null;
  label: string;
  compact?: boolean;
}) {
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copying, setCopying] = useState(false);
  const copied = Boolean(value && copiedValue === value);
  return (
    <Button
      size={compact ? 'sm' : 'default'}
      variant="outline"
      icon={copied ? <Check /> : <Clipboard />}
      disabled={!value || copying}
      {...(failed ? { title: '请检查浏览器剪贴板权限后重试' } : {})}
      onPress={async () => {
        if (!value || copying) return;
        setFailed(false);
        setCopying(true);
        try {
          await navigator.clipboard.writeText(value);
          setCopiedValue(value);
        } catch {
          setFailed(true);
        } finally {
          setCopying(false);
        }
      }}
    >
      {failed ? '复制失败，重试' : copied ? '已复制' : copying ? '正在复制…' : label}
    </Button>
  );
}
