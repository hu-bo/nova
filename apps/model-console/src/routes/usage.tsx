import { useQuery } from "@tanstack/react-query";
import { BarChart3, Coins, Database, RefreshCw, Sigma } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { getUsage, listModels, type GetUsageParams, type UsageStatus } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { PageHeader, TableFrame, tableCellClass, tableHeadClass } from "../components/page.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback.js";
import { FieldLabel, Input, NativeSelect, fieldInputClass } from "../components/ui/form.js";

export function UsageRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const params = {
    from: searchParams.get("from") ?? firstDayOfMonth(),
    to: searchParams.get("to") ?? today(),
    modelId: searchParams.get("modelId") ?? "",
    status: searchParams.get("status") ?? "",
  };
  const [draft, setDraft] = useState(params);
  const filters = useMemo<GetUsageParams>(
    () => ({
      from: startOfDay(params.from),
      to: endOfDay(params.to),
      ...(params.modelId ? { modelId: params.modelId } : {}),
      ...(params.status ? { status: params.status as UsageStatus } : {}),
    }),
    [params.from, params.to, params.modelId, params.status],
  );
  const usageQuery = useQuery({
    queryKey: queryKeys.usage(filters),
    queryFn: ({ signal }) => getUsage(filters, { signal }),
    refetchInterval: 30_000,
  });
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
        eyebrow="Harness runtime"
        title="用量与费用"
        description="按 Run 查看 Harness 实际记录的 Token 使用量和估算费用。一个 Run 只计量一次；金额按模型目录中的价格计算。"
        action={
          <Button
            onPress={() => void usageQuery.refetch()}
            isDisabled={usageQuery.isFetching}
          >
            <RefreshCw className={`size-4 ${usageQuery.isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
            刷新
          </Button>
        }
      />
      <Card className="p-5">
        <form onSubmit={applyFilters} className="grid items-end gap-4 md:grid-cols-2 xl:grid-cols-5">
          <FieldLabel label="开始日期">
            <Input
              type="date"
              value={draft.from}
              max={draft.to}
              onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
              className={fieldInputClass}
            />
          </FieldLabel>
          <FieldLabel label="结束日期">
            <Input
              type="date"
              value={draft.to}
              min={draft.from}
              onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
              className={fieldInputClass}
            />
          </FieldLabel>
          <FieldLabel label="模型">
            <NativeSelect
              value={draft.modelId}
              onChange={(event) => setDraft((current) => ({ ...current, modelId: event.target.value }))}
            >
              <option value="">全部模型</option>
              {modelsQuery.data?.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.publicName}
                </option>
              ))}
            </NativeSelect>
          </FieldLabel>
          <FieldLabel label="运行状态">
            <NativeSelect
              value={draft.status}
              onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))}
            >
              <option value="">全部状态</option>
              {USAGE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {USAGE_STATUS_VIEWS[value].label}
                </option>
              ))}
            </NativeSelect>
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
      ) : report ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon={<BarChart3 className="size-5" />} label="Harness Runs" value={formatNumber(report.totals.requests)} />
            <Metric
              icon={<Sigma className="size-5" />}
              label="输入 / 输出 Token"
              value={`${formatNumber(report.totals.input)} / ${formatNumber(report.totals.output)}`}
            />
            <Metric
              icon={<Database className="size-5" />}
              label="缓存读取 / 推理 Token"
              value={`${formatNumber(report.totals.cacheRead)} / ${formatNumber(report.totals.reasoning)}`}
            />
            <Metric icon={<Coins className="size-5" />} label="估算费用" value={report.totals.cost} />
          </div>
          <p className="text-right text-xs text-muted-foreground">
            汇总 {formatDate(report.from)} 至 {formatDate(report.to)} · 更新于 {formatDate(report.generatedAt)} · 每 30 秒自动刷新
          </p>
          {report.items.length === 0 ? (
            <Card>
              <EmptyState
                icon={<BarChart3 className="size-5" />}
                title="筛选范围内没有用量"
                description="Harness 会在每个 Run 进入终态后写入用量。"
              />
            </Card>
          ) : (
            <TableFrame>
              <table className="w-full min-w-[1180px]">
                <thead className={tableHeadClass}>
                  <tr>
                    <th className="px-5 py-3">时间</th>
                    <th className="px-5 py-3">对话</th>
                    <th className="px-5 py-3">模型 / 版本</th>
                    <th className="px-5 py-3">状态</th>
                    <th className="px-5 py-3 text-right">输入</th>
                    <th className="px-5 py-3 text-right">输出</th>
                    <th className="px-5 py-3 text-right">缓存</th>
                    <th className="px-5 py-3 text-right">推理</th>
                    <th className="px-5 py-3 text-right">费用</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {report.items.map((item) => (
                    <tr key={item.id} className="transition hover:bg-surface-secondary">
                      <td className={tableCellClass}>{formatDate(item.createdAt)}</td>
                      <td
                        className={`${tableCellClass} max-w-48 truncate font-medium text-foreground`}
                        title={item.conversationTitle}
                      >
                        {item.conversationTitle || "未命名会话"}
                      </td>
                      <td className={tableCellClass}>
                        <span>{item.modelName}</span>
                        <span className="ml-1.5 text-xs text-muted-foreground">v{item.modelConfigVersion}</span>
                      </td>
                      <td className={tableCellClass}>
                        <UsageBadge status={item.status} estimated={item.estimated} />
                      </td>
                      <td className={`${tableCellClass} text-right tabular-nums`}>{formatNumber(item.input)}</td>
                      <td className={`${tableCellClass} text-right tabular-nums`}>{formatNumber(item.output)}</td>
                      <td className={`${tableCellClass} text-right tabular-nums`}>{formatNumber(item.cacheRead)}</td>
                      <td className={`${tableCellClass} text-right tabular-nums`}>{formatNumber(item.reasoning)}</td>
                      <td className={`${tableCellClass} text-right font-mono text-xs`}>{item.cost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.totals.requests > report.items.length && (
                <p className="px-5 py-3 text-xs text-muted-foreground">
                  显示最近 500 条 Run；上方汇总包含完整筛选范围。
                </p>
              )}
            </TableFrame>
          )}
        </>
      ) : null}
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Card className="p-5">
      <div className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">{icon}</div>
      <p className="mt-4 text-xl font-bold text-foreground">{value}</p>
      <p className="mt-1 text-xs font-medium text-muted-foreground">{label}</p>
    </Card>
  );
}

/** 运行状态的文案与配色注册表：筛选下拉与表格徽标共用；未知状态按“失败”呈现。 */
const USAGE_STATUS_VIEWS: Record<UsageStatus, { label: string; className: string }> = {
  succeeded: { label: "完成", className: "bg-success/10 text-success" },
  failed: { label: "失败", className: "bg-danger/10 text-danger" },
  cancelled: { label: "已停止", className: "bg-warning/10 text-warning-foreground" },
  timed_out: { label: "超时", className: "bg-warning/10 text-warning-foreground" },
};
const USAGE_STATUSES = Object.keys(USAGE_STATUS_VIEWS) as UsageStatus[];

function UsageBadge({ status, estimated }: { status: UsageStatus; estimated: boolean }) {
  const view = USAGE_STATUS_VIEWS[status] ?? USAGE_STATUS_VIEWS.failed;
  return (
    <span className="flex flex-wrap gap-1.5">
      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${view.className}`}>{view.label}</span>
      {estimated && (
        <span className="rounded-full bg-surface-tertiary px-2.5 py-1 text-xs font-semibold text-muted-foreground">
          估算
        </span>
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