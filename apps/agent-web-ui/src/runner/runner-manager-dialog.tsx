import type { Runner, RunnerToken } from "@nova/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Clipboard, KeyRound, Plus, Server, Trash2 } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { useAuth } from "../auth/provider.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { Dialog } from "../components/ui/dialog.js";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { useRunnerCatalog, useRunnerConnection, useRunnerTokens } from "./use-runners.js";

interface RunnerManagerDialogProps {
  open: boolean;
  onClose: () => void;
  selectedRunnerId?: string | undefined;
  onSelect?: (runnerId: string) => unknown | Promise<unknown>;
}

export function RunnerManagerDialog({ open, onClose, selectedRunnerId, onSelect }: RunnerManagerDialogProps) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const catalog = useRunnerCatalog(open);
  const tokens = useRunnerTokens(open);
  const connection = useRunnerConnection(open);
  const [deletingToken, setDeletingToken] = useState<RunnerToken | null>(null);
  const [deletingRunner, setDeletingRunner] = useState<Runner | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.runners }),
      queryClient.invalidateQueries({ queryKey: queryKeys.runnerTokens }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
    ]);
  const createToken = useMutation({ mutationFn: () => api!.createRunnerToken(), onSuccess: refresh });
  const removeToken = useMutation({
    mutationFn: (id: string) => api!.deleteRunnerToken(id),
    onSuccess: async () => {
      setDeletingToken(null);
      await refresh();
    },
  });
  const removeRunner = useMutation({
    mutationFn: (id: string) => api!.deleteRunner(id),
    onSuccess: async () => {
      setDeletingRunner(null);
      await refresh();
    },
  });
  const tokenItems = (tokens.data ?? []) as RunnerToken[];
  const tokenById = new Map(tokenItems.map((token) => [token.id, token]));
  const endpoint = connection.data?.endpoint;

  async function select(runnerId: string) {
    if (!onSelect) return;
    setSelecting(runnerId);
    try {
      await onSelect(runnerId);
      onClose();
    } finally {
      setSelecting(null);
    }
  }

  return (
    <>
      <Dialog open={open} onClose={onClose} size="xl" title="Runner 与连接令牌">
        <div className="grid gap-8">
          <section aria-labelledby="runner-token-title">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h3 id="runner-token-title" className="font-semibold text-slate-900">
                  Runner Token
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Runner 通过 token 归属到当前账号；删除前必须先移除所有绑定 Runner。
                </p>
              </div>
              <Button
                variant="primary"
                icon={<Plus />}
                disabled={tokenItems.length >= 3 || createToken.isPending}
                onClick={() => createToken.mutate()}
              >
                {createToken.isPending ? "创建中…" : "新增 Token"}
              </Button>
            </div>
            {connection.isLoading && <p className="mb-3 text-sm text-slate-500">正在从服务端加载 Runner 连接地址…</p>}
            {connection.error && (
              <div className="mb-3">
                <ErrorState message={errorMessage(connection.error)} onRetry={() => void connection.refetch()} />
              </div>
            )}
            {tokens.isLoading ? (
              <LoadingState label="正在加载 token" />
            ) : tokens.error ? (
              <ErrorState message={errorMessage(tokens.error)} onRetry={() => void tokens.refetch()} />
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
                          {token.boundRunnerIds.length
                            ? `已绑定 ${token.boundRunnerIds.length} 个 Runner`
                            : "尚未绑定 Runner"}
                        </span>
                      </div>
                    </div>
                    <code
                      className="block min-w-0 truncate rounded-md bg-slate-100 px-2.5 py-1.5 text-xs text-slate-600"
                      title={token.token}
                    >
                      {token.token}
                    </code>
                    <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                      <CopyButton value={token.token} label="复制 Token" compact />
                      <CopyButton
                        value={endpoint ? runnerCommand(endpoint, token.token) : null}
                        label="复制命令"
                        compact
                      />
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`删除 Token ${index + 1}`}
                        onClick={() => setDeletingToken(token)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                ))}
              </Card>
            )}
            {createToken.error && (
              <p className="mt-3 text-sm text-rose-700" role="alert">
                {errorMessage(createToken.error)}
              </p>
            )}
          </section>

          <section aria-labelledby="runner-list-title">
            <div className="mb-4">
              <h3 id="runner-list-title" className="font-semibold text-slate-900">
                已注册 Runner
              </h3>
              <p className="mt-1 text-sm text-slate-500">Runner 启动后自动注册；状态通过服务端事件实时刷新。</p>
            </div>
            {catalog.isLoading ? (
              <LoadingState label="正在加载 Runner" />
            ) : catalog.error ? (
              <ErrorState message={errorMessage(catalog.error)} onRetry={() => void catalog.refetch()} />
            ) : !catalog.runners.length ? (
              <EmptyState
                icon={<Server />}
                title="还没有 Runner"
                description="复制上方启动命令，在目标 workspace 中运行后会自动出现在这里。"
              />
            ) : (
              <Card className="overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Runner</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>Workspace</TableHead>
                      <TableHead>启动命令</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {catalog.runners.map((runner) => {
                      const token = tokenById.get(runner.tokenId);
                      return (
                        <TableRow key={runner.id}>
                          <TableCell>
                            <strong className="block text-slate-900">{runner.id}</strong>
                            <span className="text-xs">
                              {runner.platform} · v{runner.version}
                            </span>
                          </TableCell>
                          <TableCell>
                            <RunnerStateBadge state={runner.state} running={runner.running} />
                          </TableCell>
                          <TableCell>
                            <span className="block max-w-64 truncate" title={runner.rootWorkspace}>
                              {displayWorkspacePath(runner.rootWorkspace)}
                            </span>
                          </TableCell>
                          <TableCell>
                            {token ? (
                              <CopyButton
                                value={
                                  endpoint
                                    ? runnerCommand(endpoint, token.token, runner.id, runner.rootWorkspace)
                                    : null
                                }
                                label="复制命令"
                                compact
                              />
                            ) : (
                              <span className="text-xs text-rose-600">Token 已不可用</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-2">
                              {onSelect &&
                                (selectedRunnerId === runner.id ? (
                                  <Badge variant="primary">
                                    <Check />
                                    当前
                                  </Badge>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={selecting !== null}
                                    onClick={() => void select(runner.id)}
                                  >
                                    {selecting === runner.id ? "切换中…" : "选择"}
                                  </Button>
                                ))}
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={
                                  runner.state === "disconnected" ? `删除 ${runner.id}` : "在线 Runner 需停止后删除"
                                }
                                disabled={runner.state !== "disconnected"}
                                onClick={() => setDeletingRunner(runner)}
                              >
                                <Trash2 />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </Card>
            )}
            {catalog.hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="outline"
                  disabled={catalog.isFetchingNextPage}
                  onClick={() => void catalog.fetchNextPage()}
                >
                  {catalog.isFetchingNextPage ? "加载中…" : "加载更多"}
                </Button>
              </div>
            )}
          </section>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(deletingToken)}
        onClose={() => setDeletingToken(null)}
        title="删除 Runner Token"
        description="此操作无法撤销。"
        size="sm"
      >
        {deletingToken?.boundRunnerIds.length ? (
          <div>
            <p className="text-sm leading-6 text-slate-600">
              该 token 仍被以下 Runner 绑定，请先停止并删除这些 Runner：
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {deletingToken.boundRunnerIds.map((id) => (
                <Badge key={id} variant="warning">
                  {id}
                </Badge>
              ))}
            </div>
            <div className="mt-6 flex justify-end">
              <Button onClick={() => setDeletingToken(null)}>知道了</Button>
            </div>
          </div>
        ) : (
          <div>
            <p className="text-sm text-slate-600">确定删除这个 runner_token 吗？使用它的启动命令会立即失效。</p>
            {removeToken.error && <p className="mt-3 text-sm text-rose-700">{errorMessage(removeToken.error)}</p>}
            <div className="mt-6 flex justify-end gap-3">
              <Button onClick={() => setDeletingToken(null)}>取消</Button>
              <Button
                variant="danger"
                disabled={removeToken.isPending}
                onClick={() => deletingToken && removeToken.mutate(deletingToken.id)}
              >
                {removeToken.isPending ? "删除中…" : "删除"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={Boolean(deletingRunner)}
        onClose={() => setDeletingRunner(null)}
        title="删除离线 Runner"
        description="删除注册记录后，Runner 再次启动仍会自动注册。"
        size="sm"
      >
        <p className="text-sm text-slate-600">确定删除“{deletingRunner?.id}”吗？</p>
        {removeRunner.error && <p className="mt-3 text-sm text-rose-700">{errorMessage(removeRunner.error)}</p>}
        <div className="mt-6 flex justify-end gap-3">
          <Button onClick={() => setDeletingRunner(null)}>取消</Button>
          <Button
            variant="danger"
            disabled={removeRunner.isPending}
            onClick={() => deletingRunner && removeRunner.mutate(deletingRunner.id)}
          >
            {removeRunner.isPending ? "删除中…" : "删除"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function RunnerStateBadge({ state, running }: { state: Runner["state"]; running: number }) {
  const variant = state === "ready" ? "success" : state === "disconnected" ? "danger" : "warning";
  const label =
    state === "ready" ? "在线" : state === "busy" ? `忙碌 · ${running}` : state === "draining" ? "排空中" : "离线";
  return (
    <Badge variant={variant}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </Badge>
  );
}

function CopyButton({ value, label, compact = false }: { value: string | null; label: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size={compact ? "sm" : "default"}
      variant="outline"
      icon={copied ? <Check /> : <Clipboard />}
      disabled={!value}
      onClick={() =>
        value &&
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        })
      }
    >
      {copied ? "已复制" : label}
    </Button>
  );
}

function runnerCommand(endpoint: string, token: string, runnerId?: string, workspace = "<workspace>") {
  const executable = import.meta.env.DEV ? "cargo run -p nova-runner --" : "nova-runner";
  return `${executable} --server "${endpoint}" --token "${token}"${runnerId ? ` --runner-id "${runnerId}"` : ""} --workspace "${workspace}"`;
}

function displayWorkspacePath(path: string) {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  if (path.startsWith("\\\\?\\")) return path.slice("\\\\?\\".length);
  return path;
}
