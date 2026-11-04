import { z } from "zod";
import type { GetUsageParams } from "@/api/client";

export const usageSearchSchema = z.object({
  from: z.iso.date().optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
  modelId: z.string().optional().catch(undefined),
  status: z.enum(["succeeded", "failed", "cancelled", "timed_out"]).optional().catch(undefined),
});

export type UsageSearch = z.infer<typeof usageSearchSchema>;
export interface UsageFilterValues {
  from: string;
  to: string;
  modelId: string;
  status: string;
}

function localDate(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function resolveUsageSearch(search: UsageSearch, now = new Date()) {
  const firstDay = new Date(now);
  firstDay.setDate(1);
  const from = search.from ?? localDate(firstDay);
  const to = search.to ?? localDate(now);
  return {
    from: from <= to ? from : to,
    to,
    modelId: search.modelId ?? "",
    status: search.status ?? "",
  };
}

export function toUsageApiParams(search: UsageSearch): GetUsageParams {
  const values = resolveUsageSearch(search);
  return {
    from: new Date(`${values.from}T00:00:00`).toISOString(),
    to: new Date(`${values.to}T23:59:59.999`).toISOString(),
    ...(values.modelId ? { modelId: values.modelId } : {}),
    ...(search.status ? { status: search.status } : {}),
  };
}
