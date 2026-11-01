import { useEffect, useState } from 'react';
import { ApiError, errorMessage } from '@/api/api-error';
import { Button } from './ui/button';
export function ErrorNotice({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: (() => void) | undefined;
}) {
  const seconds = error instanceof ApiError ? (error.retryAfterSeconds ?? 0) : 0;
  const [remaining, setRemaining] = useState(seconds);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setRemaining(seconds);
    const timer = setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [seconds, error]);
  const notified = error instanceof ApiError && error.notified;
  if (notified && !onRetry) return null;
  return (
    <div
      role="alert"
      className="rounded-xl border border-danger/20 bg-danger/5 p-3 text-sm text-danger"
    >
      <p className="break-words">
        {notified ? '加载失败，请重试。' : errorMessage(error)}
        {remaining > 0 ? ` 请等待 ${remaining} 秒。` : ''}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {onRetry && (
          <Button variant="outline" size="sm" disabled={remaining > 0} onPress={onRetry}>
            重试
          </Button>
        )}
        {error instanceof ApiError && error.requestId && (
          <Button
            variant="ghost"
            size="sm"
            onPress={() => {
              void navigator.clipboard
                .writeText(error.requestId!)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? '已复制请求编号' : `复制请求编号 ${error.requestId}`}
          </Button>
        )}
      </div>
    </div>
  );
}
