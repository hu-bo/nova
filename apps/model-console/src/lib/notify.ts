import { toast } from "@heroui/react";
import type { ReactNode } from "react";

export type NotifyVariant = "default" | "accent" | "success" | "warning" | "danger";

type ToastOptions = NonNullable<Parameters<typeof toast>[1]>;

export interface NotifyOptions {
  description?: ReactNode;
  variant?: NotifyVariant;
  /** 自动关闭时间（毫秒）；0 表示常驻，需要用户手动关闭。 */
  timeout?: number;
  indicator?: ReactNode;
  actionProps?: ToastOptions["actionProps"];
  onClose?: () => void;
}

/** 通知默认停留时间（毫秒），与 HeroUI 默认保持一致。 */
const DEFAULT_TIMEOUT = 4000;

function toToastOptions(options: NotifyOptions): ToastOptions {
  // exactOptionalPropertyTypes 下不能显式传 undefined，只能按需赋值。
  const payload: ToastOptions = {};
  if (options.variant !== undefined) payload.variant = options.variant;
  if (options.description !== undefined) payload.description = options.description;
  if (options.indicator !== undefined) payload.indicator = options.indicator;
  if (options.actionProps !== undefined) payload.actionProps = options.actionProps;
  if (options.timeout !== undefined) payload.timeout = options.timeout;
  if (options.onClose !== undefined) payload.onClose = options.onClose;
  return payload;
}

/**
 * 通知（toast）统一出口：全局提示都从这里发出，
 * 便于统一文案、样式与去重策略。
 */
export function notify(message: ReactNode, options: NotifyOptions = {}): string {
  return toast(message, toToastOptions(options));
}

/** 关闭指定通知。 */
export function closeNotification(id: string): void {
  toast.close(id);
}

/** 正在显示的通知：key -> HeroUI toast id。 */
const activeNotifications = new Map<string, string>();

/**
 * 同一 key 只保留一条通知：重复触发时更新已有通知并重置计时，
 * 避免批量请求同时失败时堆叠成一屏。
 */
export function notifyOnce(key: string, message: ReactNode, options: NotifyOptions = {}): string {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const handleClose = () => {
    activeNotifications.delete(key);
    options.onClose?.();
  };
  const existing = activeNotifications.get(key);
  if (existing) {
    // 通知可能已经自动关闭，此时 update 会补发一条新的并返回新的 id。
    const id = toast.update(existing, message, {
      ...toToastOptions(options),
      timeout,
      onClose: handleClose,
    });
    activeNotifications.set(key, id);
    return id;
  }
  const id = notify(message, { ...options, timeout, onClose: handleClose });
  activeNotifications.set(key, id);
  return id;
}
