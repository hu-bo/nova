import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKey,
  type CreateApiKey,
  type CreatedApiKey,
} from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { CreateKeyForm } from "../api-keys/create-key-form.js";
import { SecretDialog } from "../api-keys/secret-dialog.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { PageHeader, StatusBadge } from "../components/page.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";

export function KeysRoute() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.apiKeys, queryFn: ({ signal }) => listApiKeys({ signal }) });
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const revokeMutation = useMutation({
    mutationFn: (key: ApiKey) => revokeApiKey(key.id),
    onSuccess: async () => {
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
      await queryClient.invalidateQueries({ queryKey: queryKeys.quotas });
    },
  });
  const keys = query.data ?? [];
  const handleCreate = async (input: CreateApiKey) => {
    const result = await createApiKey(input);
    setCreated(result);
    await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    await queryClient.invalidateQueries({ queryKey: queryKeys.quotas });
    return result;
  };

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Credentials"
        title="API Keys"
        description="下发给业务侧的高熵凭据。列表只展示安全前缀，吊销后不可恢复。"
        action={
          <Button variant="primary" icon={<Plus />} onClick={() => setCreateOpen(true)}>
            创建 API Key
          </Button>
        }
      />
      {query.isLoading ? (
        <LoadingState label="正在加载 API Keys" />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : keys.length === 0 ? (
        <Card>
          <EmptyState
            icon={<KeyRound />}
            title="还没有 API Key"
            description="创建一个 Key 后，可为它配置速率限制与月度预算。"
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                创建第一个 Key
              </Button>
            }
          />
        </Card>
      ) : (
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>安全前缀</TableHead>
              <TableHead>租户</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="font-semibold text-slate-900">
                  <span className="inline-flex items-center gap-2">
                    <ShieldCheck className="size-4 text-indigo-500" />
                    {key.name}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs">{key.keyPrefix}••••••••</TableCell>
                <TableCell>{key.ownerId}</TableCell>
                <TableCell>{formatDate(key.createdAt)}</TableCell>
                <TableCell>
                  <StatusBadge enabled={key.enabled} enabledLabel="有效" disabledLabel="已吊销" />
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                    disabled={!key.enabled}
                    icon={<Trash2 />}
                    onClick={() => setRevoking(key)}
                  >
                    吊销
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <CreateKeyForm open={createOpen} onClose={() => setCreateOpen(false)} onCreate={handleCreate} />
      <SecretDialog created={created} onAcknowledge={() => setCreated(null)} />
      <ConfirmDialog
        open={revoking !== null}
        title={`吊销 ${revoking?.name ?? "API Key"}`}
        description="吊销不可逆，该 Key 的后续请求会立即失败；历史用量仍会保留。"
        confirmLabel="确认永久吊销"
        danger
        pending={revokeMutation.isPending}
        onClose={() => setRevoking(null)}
        onConfirm={() => {
          if (revoking) revokeMutation.mutate(revoking);
        }}
      />
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
