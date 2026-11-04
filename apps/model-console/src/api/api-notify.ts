import { notifyOnce } from "@/lib/notify";
import type { NotifyVariant } from "@/lib/notify";

/** 需要以通知形式提示的 API 失败类型。 */
export type ApiFailureKind = "network" | "server" | "response" | "request";

const VARIANT_BY_KIND: Record<ApiFailureKind, NotifyVariant> = {
  network: "danger",
  server: "warning",
  response: "warning",
  request: "danger",
};

/**
 * 相同类型和文案的失败合并，不同业务错误各自提示。
 */
export function notifyApiFailure(kind: ApiFailureKind, message: string, description?: string): void {
  notifyOnce(`api-failure:${kind}:${message}`, message, {
    variant: VARIANT_BY_KIND[kind],
    description,
  });
}
