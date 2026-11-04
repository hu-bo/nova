import { AlertCircle } from 'lucide-react';
import { Button } from './button';

export function ErrorState({
  title = '加载失败',
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-xl bg-rose-50 p-5 ring-1 ring-rose-200" role="alert">
      <div className="flex gap-3">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-rose-600" aria-hidden="true" />
        <div className="min-w-0">
          <h3 className="font-semibold text-rose-900">{title}</h3>
          <p className="mt-1 break-words text-sm leading-6 text-rose-700">{message}</p>
          {onRetry && (
            <Button type="button" variant="secondary" className="mt-3" onPress={onRetry}>
              重试
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
