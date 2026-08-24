import { useQuery } from "@tanstack/react-query";
import { BarChart3, Coins, Database, RefreshCw, Sigma } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { getUsage, listApiKeys, listModels, type GetUsageParams, type UsageStatus } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { PageHeader, TableFrame, tableCellClass, tableHeadClass } from "../components/page.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback.js";
import { FieldLabel, Input, Select } from "../components/ui/form.js";

export function UsageRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFrom = searchParams.get("from") ?? firstDayOfMonth();
  const initialTo = searchParams.get("to") ?? today();
  const [draft, setDraft] = useState({
    from: initialFrom,
    to: initialTo,
    apiKeyId: searchParams.get("apiKeyId") ?? "",
    modelId: searchParams.get("modelId") ?? "",
    status: searchParams.get("status") ?? "",
  });
  const filters: GetUsageParams = {
    from: startOfDay(initialFrom),
    to: endOfDay(initialTo),
    limit: 100,
    ...(searchParams.get("apiKeyId") ? { apiKeyId: searchParams.get("apiKeyId")! } : {}),
    ...(searchParams.get("modelId") ? { modelId: searchParams.get("modelId")! } : {}),
    ...(searchParams.get("status") ? { status: searchParams.get("status") as UsageStatus } : {}),
  };
  const usageQuery = useQuery({
    queryKey: queryKeys.usage(filters),
    queryFn: ({ signal }) => getUsage(filters, { signal }),
    refetchInterval: 30_000,
  });
  const keysQuery = useQuery({ queryKey: queryKeys.apiKeys, queryFn: ({ signal }) => listApiKeys({ signal }) });
  const modelsQuery = useQuery({ queryKey: queryKeys.models, queryFn: ({ signal }) => listModels({ signal }) });
  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(draft)) if (value) next.set(key, value);
    setSearchParams(next, { replace: true });
  };
  const report = usageQuery.data;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Reporting"
        title="用量与计费"
        description="按时间、Key 和模型查看已落库的请求终态。数据可能有短暂计量延迟，估算值会单独标记。"
        action={
          <Button
            icon={<RefreshCw className={`size-4 ${usageQuery.isFetching ? "animate-spin" : ""}`} />}
            onClick={() => void usageQuery.refetch()}
            disabled={usageQuery.isFetching}
          >
            刷新
          </Button>
        }
      />
      <Card className="p-5">
        <form onSubmit={applyFilters} className="grid items-end gap-4 md:grid-cols-2 xl:grid-cols-6">
          <FieldLabel label="开始日期">
            <Input
              type="date"
              value={draft.from}
              max={draft.to}
              onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
            />
          </FieldLabel>
          <FieldLabel label="结束日期">
            <Input
              type="date"
              value={draft.to}
              min={draft.from}
              onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
            />
          </FieldLabel>
          <FieldLabel label="API Key">
            <Select
              value={draft.apiKeyId}
              onChange={(event) => setDraft((current) => ({ ...current, apiKeyId: event.target.value }))}
            >
              <option value="">全部 Key</option>
              {keysQuery.data?.map((key) => (
                <option key={key.id} value={key.id}>
                  {key.name}
                </option>
              ))}
            </Select>
          </FieldLabel>
          <FieldLabel label="模型">
            <Select
              value={draft.modelId}
              onChange={(event) => setDraft((current) => ({ ...current, modelId: event.target.value }))}
            >
              <option value="">全部模型</option>
              {modelsQuery.data?.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.publicName}
                </option>
              ))}
            </Select>
          </FieldLabel>
          <FieldLabel label="请求状态">
            <Select
              value={draft.status}
              onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))}
            >
              <option value="">全部状态</option>
              <option value="completed">完成</option>
              <option value="aborted">已中断</option>
              <option value="error">错误</option>
            </Select>
          </FieldLabel>
          <Button type="submit" variant="primary">
            应用筛选
          </Button>
        </form>
      </Card>
      {usageQuery.isLoading ? (
        <LoadingState label="正在汇总用量" />
      ) : usageQuery.error ? (
        <ErrorState error={usageQuery.error} onRetry={() => void usageQuery.refetch()} />
      ) : (
        report && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Metric
                icon={<BarChart3 className="size-5" />}
                label="请求数"
                value={formatNumber(report.totals.requests)}
              />
              <Metric
                icon={<Sigma className="size-5" />}
                label="输入 / 输出 Token"
                value={`${formatNumber(report.totals.input)} / ${formatNumber(report.totals.output)}`}
              />
              <Metric
                icon={<Database className="size-5" />}
                label="缓存读取"
                value={formatNumber(report.totals.cacheRead)}
              />
              <Metric icon={<Coins className="size-5" />} label="结算费用" value={report.totals.cost} />
            </div>
            <p className="text-right text-xs text-slate-400">
              报表生成于 {formatDate(report.generatedAt)} · 每 30 秒自动刷新
            </p>
            {report.items.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<BarChart3 className="size-5" />}
                  title="筛选范围内没有用量"
                  description="计量会在请求进入终态后写入；可以扩大日期范围或清除筛选条件。"
                />
              </Card>
            ) : (
              <TableFrame>
                <table className="w-full min-w-[1050px]">
                  <thead className={tableHeadClass}>
                    <tr>
                      <th className="px-5 py-3">时间</th>
                      <th className="px-5 py-3">API Key</th>
                      <th className="px-5 py-3">模型</th>
                      <th className="px-5 py-3">状态</th>
                      <th className="px-5 py-3 text-right">输入</th>
                      <th className="px-5 py-3 text-right">输出</th>
                      <th className="px-5 py-3 text-right">缓存</th>
                      <th className="px-5 py-3 text-right">费用</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {report.items.map((item) => (
                      <tr key={item.id} className="transition hover:bg-slate-50/70">
                        <td className={tableCellClass}>{formatDate(item.createdAt)}</td>
                        <td className={`${tableCellClass} font-medium text-slate-800`}>{item.apiKeyName}</td>
                        <td className={tableCellClass}>{item.modelName}</td>
                        <td className={tableCellClass}>
                          <UsageBadge status={item.status} estimated={item.estimated} />
                        </td>
                        <td className={`${tableCellClass} text-right tabular-nums`}>{formatNumber(item.input)}</td>
                        <td className={`${tableCellClass} text-right tabular-nums`}>{formatNumber(item.output)}</td>
                        <td className={`${tableCellClass} text-right tabular-nums`}>{formatNumber(item.cacheRead)}</td>
                        <td className={`${tableCellClass} text-right font-mono text-xs`}>{item.cost}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            )}
          </>
        )
      )}
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <div className="grid size-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600">{icon}</div>
      </div>
      <p className="mt-4 text-xl font-bold text-slate-900">{value}</p>
      <p className="mt-1 text-xs font-medium text-slate-500">{label}</p>
    </Card>
  );
}
function UsageBadge({ status, estimated }: { status: UsageStatus; estimated: boolean }) {
  const styles =
    status === "completed"
      ? "bg-emerald-50 text-emerald-700"
      : status === "aborted"
        ? "bg-amber-50 text-amber-700"
        : "bg-rose-50 text-rose-700";
  const label = status === "completed" ? "完成" : status === "aborted" ? "中断" : "错误";
  return (
    <span className="flex flex-wrap gap-1.5">
      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${styles}`}>{label}</span>
      {estimated && (
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">估算</span>
      )}
    </span>
  );
}
function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
function today() {
  return localDate(new Date());
}
function firstDayOfMonth() {
  const date = new Date();
  date.setDate(1);
  return localDate(date);
}
function localDate(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}
function startOfDay(value: string) {
  return new Date(`${value}T00:00:00`).toISOString();
}
function endOfDay(value: string) {
  return new Date(`${value}T23:59:59.999`).toISOString();
}
