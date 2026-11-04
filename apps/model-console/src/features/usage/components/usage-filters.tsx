import { useState, type FormEvent } from "react";
import type { Model } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FieldLabel, Input, NativeSelect, fieldInputClass } from "@/components/ui/form";
import type { UsageFilterValues } from "../usage-search";

const statusLabels = { succeeded: "完成", failed: "失败", cancelled: "已停止", timed_out: "超时" };
const usageStatuses = Object.keys(statusLabels) as Array<keyof typeof statusLabels>;

export function UsageFilters({
  filters,
  models,
  onApply,
}: {
  filters: UsageFilterValues;
  models: Model[];
  onApply: (values: UsageFilterValues) => void;
}) {
  const [draft, setDraft] = useState(filters);
  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    onApply(draft);
  };
  return (
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
            {models.map((model) => (
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
            {usageStatuses.map((value) => (
              <option key={value} value={value}>
                {statusLabels[value]}
              </option>
            ))}
          </NativeSelect>
        </FieldLabel>
        <Button type="submit" variant="primary">
          应用筛选
        </Button>
      </form>
    </Card>
  );
}
