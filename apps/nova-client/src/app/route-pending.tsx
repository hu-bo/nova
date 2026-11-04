import { LoaderCircle } from 'lucide-react';

export function RoutePending() {
  return (
    <div
      role="status"
      className="flex min-h-64 items-center justify-center gap-3 text-sm text-muted-foreground"
    >
      <LoaderCircle className="animate-spin" size={18} />
      正在加载…
    </div>
  );
}
