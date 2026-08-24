import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge, Pencil, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { listQuotas, updateQuota, type Quota, type UpdateQuota } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { PageHeader, TableFrame, tableCellClass, tableHeadClass } from "../components/page.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback.js";
import { QuotaForm } from "../quotas/quota-form.js";

export function QuotasRoute() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.quotas, queryFn: ({ signal }) => listQuotas({ signal }) });
  const [editing, setEditing] = useState<Quota | null>(null);
  const mutation = useMutation({
    mutationFn: ({ quota, input }: { quota: Quota; input: UpdateQuota }) => updateQuota(quota.apiKeyId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.quotas });
    },
  });
  const quotas = query.data ?? [];
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Guardrails"
        title="配额策略"
        description="为每个 API Key 设置 RPM、TPM 和月度费用上限；留空表示不限。"
      />
      {query.isLoading ? (
        <LoadingState label="正在加载配额" />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : quotas.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Gauge className="size-5" />}
            title="还没有可配置的 API Key"
            description="先创建业务侧 API Key，再为它设置速率和预算边界。"
          />
        </Card>
      ) : (
        <TableFrame>
          <table className="w-full min-w-[760px]">
            <thead className={tableHeadClass}>
              <tr>
                <th className="px-5 py-3">API Key</th>
                <th className="px-5 py-3">RPM</th>
                <th className="px-5 py-3">TPM</th>
                <th className="px-5 py-3">月度费用</th>
                <th className="px-5 py-3">更新时间</th>
                <th className="px-5 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {quotas.map((quota) => (
                <tr key={quota.apiKeyId} className="transition hover:bg-slate-50/70">
                  <td className={tableCellClass}>
                    <p className="flex items-center gap-2 font-semibold text-slate-900">
                      <ShieldCheck className="size-4 text-indigo-500" />
                      {quota.keyName}
                    </p>
                    <p className="mt-1 font-mono text-xs text-slate-400">{quota.keyPrefix}••••••••</p>
                  </td>
                  <td className={`${tableCellClass} font-medium text-slate-800`}>
                    {quota.rpm === null ? <Unlimited /> : formatNumber(quota.rpm)}
                  </td>
                  <td className={`${tableCellClass} font-medium text-slate-800`}>
                    {quota.tpm === null ? <Unlimited /> : formatNumber(quota.tpm)}
                  </td>
                  <td className={`${tableCellClass} font-medium text-slate-800`}>
                    {quota.monthlyCost === null ? <Unlimited /> : quota.monthlyCost}
                  </td>
                  <td className={tableCellClass}>{formatDate(quota.updatedAt)}</td>
                  <td className={`${tableCellClass} text-right`}>
                    <Button
                      variant="ghost"
                      className="min-h-9 px-3"
                      icon={<Pencil className="size-4" />}
                      onClick={() => setEditing(quota)}
                    >
                      编辑策略
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      )}
      <QuotaForm
        quota={editing}
        pending={mutation.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(input) => (editing ? mutation.mutateAsync({ quota: editing, input }) : Promise.resolve())}
      />
    </div>
  );
}

function Unlimited() {
  return <span className="text-sm font-normal text-slate-400">不限</span>;
}
function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
