import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clipboard, KeyRound, Pencil, Plus, Power, ServerCog, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  createProvider,
  deleteProvider,
  listProviders,
  updateProvider,
  type CreateProvider,
  type Provider,
  type UpdateProvider,
} from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { PageHeader, StatusBadge, TableFrame, tableCellClass, tableHeadClass } from "../components/page.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback.js";
import { ProviderForm } from "../providers/provider-form.js";

type Confirmation = { kind: "disable" | "delete"; provider: Provider } | null;

export function ProvidersRoute() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.providers, queryFn: ({ signal }) => listProviders({ signal }) });
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = async (provider: Provider) => {
    await navigator.clipboard.writeText(provider.credentialMasked);
    setCopiedId(provider.id);
    setTimeout(() => setCopiedId(null), 2000);
  };
  const saveMutation = useMutation({
    mutationFn: (input: CreateProvider | UpdateProvider) =>
      editing ? updateProvider(editing.id, input) : createProvider(input as CreateProvider),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      await queryClient.invalidateQueries({ queryKey: queryKeys.models });
    },
  });
  const stateMutation = useMutation({
    mutationFn: ({ provider, enabled }: { provider: Provider; enabled: boolean }) =>
      updateProvider(provider.id, { enabled }),
    onSuccess: async () => {
      setConfirmation(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      await queryClient.invalidateQueries({ queryKey: queryKeys.models });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (provider: Provider) => deleteProvider(provider.id),
    onSuccess: async () => {
      setConfirmation(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      await queryClient.invalidateQueries({ queryKey: queryKeys.models });
    },
  });
  const providers = query.data ?? [];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Connections"
        title="Provider 连接"
        description="管理模型服务的协议、HTTPS 地址和加密凭据。模型请求仍由 adapter 直连上游。"
        action={
          <Button
            variant="primary"
            onPress={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="size-4" aria-hidden="true" />
            添加 Provider
          </Button>
        }
      />
      {!query.isLoading && !query.error && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Metric label="Provider" value={providers.length} icon={<ServerCog className="size-5" />} />
          <Metric
            label="已启用"
            value={providers.filter((item) => item.enabled).length}
            icon={<Power className="size-5" />}
          />
          <Metric
            label="已托管凭据"
            value={providers.filter((item) => item.credentialMasked).length}
            icon={<KeyRound className="size-5" />}
          />
        </div>
      )}
      {query.isLoading ? (
        <LoadingState label="正在加载 Provider" />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : providers.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ServerCog className="size-5" />}
            title="还没有 Provider"
            description="先添加一个官方或中转商连接，之后才能注册模型。"
            action={
              <Button variant="primary" onPress={() => setFormOpen(true)}>
                添加第一个 Provider
              </Button>
            }
          />
        </Card>
      ) : (
        <TableFrame>
          <table className="w-full min-w-[840px]">
            <thead className={tableHeadClass}>
              <tr>
                <th className="px-5 py-3">名称</th>
                <th className="px-5 py-3">协议</th>
                <th className="px-5 py-3">连接地址</th>
                <th className="px-5 py-3">凭据</th>
                <th className="px-5 py-3">可见范围</th>
                <th className="px-5 py-3">状态</th>
                <th className="px-5 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {providers.map((provider) => (
                <tr key={provider.id} className="transition hover:bg-surface-secondary">
                  <td className={`${tableCellClass} font-semibold text-foreground`}>{provider.name}</td>
                  <td className={tableCellClass}>
                    <span className="rounded-lg bg-surface-tertiary px-2 py-1 font-mono text-xs text-foreground">
                      {provider.protocol}
                    </span>
                  </td>
                  <td className={`${tableCellClass} max-w-xs truncate font-mono text-xs`} title={provider.baseUrl}>
                    {provider.baseUrl}
                  </td>
                  <td className={tableCellClass}>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{provider.credentialMasked}</span>
                      <button
                        onClick={() => void handleCopy(provider)}
                        className="flex-shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-surface-tertiary hover:text-foreground"
                        aria-label="复制凭据"
                      >
                        {copiedId === provider.id ? (
                          <Check className="size-3.5 text-success" />
                        ) : (
                          <Clipboard className="size-3.5" />
                        )}
                      </button>
                    </div>
                  </td>
                  <td className={tableCellClass}>
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-semibold ${provider.isPublic ? "bg-success/10 text-success" : "bg-surface-tertiary text-muted-foreground"}`}
                    >
                      {provider.isPublic ? "公开" : "仅创建者"}
                    </span>
                  </td>
                  <td className={tableCellClass}>
                    <StatusBadge enabled={provider.enabled} />
                  </td>
                  <td className={`${tableCellClass} text-right`}>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`编辑 ${provider.name}`}
                        onPress={() => {
                          setEditing(provider);
                          setFormOpen(true);
                        }}
                      >
                        <Pencil className="size-4" />
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onPress={() =>
                          provider.enabled
                            ? setConfirmation({ kind: "disable", provider })
                            : stateMutation.mutate({ provider, enabled: true })
                        }
                      >
                        <Power className="size-4" />
                        {provider.enabled ? "停用" : "启用"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger hover:bg-danger/10 hover:text-danger"
                        aria-label={`删除 ${provider.name}`}
                        isIconOnly
                        onPress={() => setConfirmation({ kind: "delete", provider })}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      )}
      <ProviderForm
        open={formOpen}
        provider={editing}
        pending={saveMutation.isPending}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSubmit={(input) => saveMutation.mutateAsync(input)}
      />
      <ConfirmDialog
        open={confirmation !== null}
        title={
          confirmation?.kind === "delete"
            ? `删除 ${confirmation.provider.name}`
            : `停用 ${confirmation?.provider.name ?? "Provider"}`
        }
        description={
          confirmation?.kind === "delete"
            ? "凭据会被永久擦除，关联模型会一并停用；历史用量仍会保留。"
            : "关联模型将无法用于后续配置，重新启用前不会恢复。"
        }
        confirmLabel={confirmation?.kind === "delete" ? "确认删除" : "确认停用"}
        danger={confirmation?.kind === "delete"}
        pending={stateMutation.isPending || deleteMutation.isPending}
        onClose={() => setConfirmation(null)}
        onConfirm={() => {
          if (!confirmation) return;
          if (confirmation.kind === "delete") deleteMutation.mutate(confirmation.provider);
          else stateMutation.mutate({ provider: confirmation.provider, enabled: false });
        }}
      />
    </div>
  );
}

function Metric({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <Card className="flex items-center gap-4 p-5">
      <div className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">{icon}</div>
      <div>
        <p className="text-2xl font-bold text-foreground">{value}</p>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
      </div>
    </Card>
  );
}