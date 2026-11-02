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

/** 停用/删除确认弹窗的文案表：新增操作种类只需在此登记。 */
const CONFIRMATION_COPY = {
  disable: {
    verb: "停用",
    description: "关联模型将无法用于后续配置，重新启用前不会恢复。",
    confirmLabel: "确认停用",
    danger: false,
  },
  delete: {
    verb: "删除",
    description: "凭据会被永久擦除，关联模型会一并停用；历史用量仍会保留。",
    confirmLabel: "确认删除",
    danger: true,
  },
} as const;

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
  // Provider 变更会级联影响模型展示，两个列表都要失效。
  const invalidateConfig = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.providers }),
      queryClient.invalidateQueries({ queryKey: queryKeys.models }),
    ]);
  const saveMutation = useMutation({
    mutationFn: (input: CreateProvider | UpdateProvider) =>
      editing ? updateProvider(editing.id, input) : createProvider(input as CreateProvider),
    onSuccess: () => invalidateConfig(),
  });
  const stateMutation = useMutation({
    mutationFn: ({ provider, enabled }: { provider: Provider; enabled: boolean }) =>
      updateProvider(provider.id, { enabled }),
    onSuccess: async () => {
      setConfirmation(null);
      await invalidateConfig();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (provider: Provider) => deleteProvider(provider.id),
    onSuccess: async () => {
      setConfirmation(null);
      await invalidateConfig();
    },
  });
  const providers = query.data ?? [];
  const confirm = confirmation
    ? {
        ...CONFIRMATION_COPY[confirmation.kind],
        title: `${CONFIRMATION_COPY[confirmation.kind].verb} ${confirmation.provider.name}`,
        isDelete: confirmation.kind === "delete",
        provider: confirmation.provider,
      }
    : null;

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
      {confirm && (
        <ConfirmDialog
          open
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          pending={stateMutation.isPending || deleteMutation.isPending}
          onClose={() => setConfirmation(null)}
          onConfirm={() =>
            confirm.isDelete
              ? deleteMutation.mutate(confirm.provider)
              : stateMutation.mutate({ provider: confirm.provider, enabled: false })
          }
        />
      )}
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