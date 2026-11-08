import { useQuery } from "@tanstack/react-query";
import { Check, Clipboard, KeyRound, Pencil, Plus, Power, ServerCog, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Provider } from "@/api/client";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader, StatusBadge } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/feedback";
import { Table, tableCellClass, tableHeadClass } from "@/components/ui/table";
import { ProviderForm, providerQueryOptions, useProviderMutations } from "@/features/providers";

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

export function ProvidersPage() {
  const query = useQuery(providerQueryOptions());
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = async (provider: Provider) => {
    await navigator.clipboard.writeText(provider.credentialMasked);
    setCopiedId(provider.id);
    setTimeout(() => setCopiedId(null), 2000);
  };
  const { saveMutation, stateMutation, deleteMutation } = useProviderMutations(editing);
  const providers = query.data ?? [];
  const confirm = confirmation
    ? {
        ...CONFIRMATION_COPY[confirmation.kind],
        title: `${CONFIRMATION_COPY[confirmation.kind].verb} ${confirmation.provider.name}`,
        isDelete: confirmation.kind === "delete",
        provider: confirmation.provider,
      }
    : null;

  /** Provider 主体按优先级呈现：加载中 → 出错 → 空列表 → Provider 表格。 */
  function renderProviderList() {
    if (query.isLoading) return <LoadingState label="正在加载 Provider" />;
    if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
    if (providers.length === 0)
      return (
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
      );
    return (
      <Table variant="secondary" className="overflow-clip rounded-xl bg-surface ring-1 ring-border">
        <Table.ScrollContainer>
          <Table.Content aria-label="Provider 列表" className="w-full min-w-[840px]">
            <Table.Header>
              <Table.Column isRowHeader className={`${tableHeadClass} rounded-none px-5 py-3`}>名称</Table.Column>
              <Table.Column className={`${tableHeadClass} px-5 py-3`}>协议</Table.Column>
              <Table.Column className={`${tableHeadClass} px-5 py-3`}>连接地址</Table.Column>
              <Table.Column className={`${tableHeadClass} px-5 py-3`}>凭据</Table.Column>
              <Table.Column className={`${tableHeadClass} px-5 py-3`}>可见范围</Table.Column>
              <Table.Column className={`${tableHeadClass} px-5 py-3`}>状态</Table.Column>
              <Table.Column className={`${tableHeadClass} rounded-none px-5 py-3 text-right`}>操作</Table.Column>
            </Table.Header>
            <Table.Body>
              {providers.map((provider) => (
                <Table.Row key={provider.id}>
                  <Table.Cell className={`${tableCellClass} font-semibold text-foreground`}>{provider.name}</Table.Cell>
                  <Table.Cell className={tableCellClass}>
                    <span className="rounded-lg bg-surface-tertiary px-2 py-1 font-mono text-xs text-foreground">
                      {provider.protocol}
                    </span>
                  </Table.Cell>
                  <Table.Cell className={`${tableCellClass} max-w-xs font-mono text-xs`}>
                    <span className="block truncate" title={provider.baseUrl}>
                      {provider.baseUrl}
                    </span>
                  </Table.Cell>
                  <Table.Cell className={tableCellClass}>
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
                  </Table.Cell>
                  <Table.Cell className={tableCellClass}>
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-semibold ${provider.isPublic ? "bg-success/10 text-success" : "bg-surface-tertiary text-muted-foreground"}`}
                    >
                      {provider.isPublic ? "公开" : "仅创建者"}
                    </span>
                  </Table.Cell>
                  <Table.Cell className={tableCellClass}>
                    <StatusBadge enabled={provider.enabled} />
                  </Table.Cell>
                  <Table.Cell className={`${tableCellClass} text-right`}>
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
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    );
  }

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
      {renderProviderList()}
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
              ? deleteMutation.mutate(confirm.provider, { onSuccess: () => setConfirmation(null) })
              : stateMutation.mutate(
                  { provider: confirm.provider, enabled: false },
                  { onSuccess: () => setConfirmation(null) },
                )
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
