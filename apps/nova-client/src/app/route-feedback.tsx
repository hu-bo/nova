import { Link, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { AlertCircle, ArrowLeft, LoaderCircle } from 'lucide-react';
import { ApiError, errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';

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

export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <div role="alert" className="rounded-2xl border bg-card px-6 py-16 text-center">
      <AlertCircle className="mx-auto mb-4 text-muted-foreground" size={32} />
      <h1 className="text-xl font-semibold">
        {error instanceof ApiError && error.status === 404
          ? '内容不存在或已被删除'
          : '暂时无法打开页面'}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">{errorMessage(error)}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link to="/conversations" className={buttonVariants({ variant: 'outline' })}>
          <ArrowLeft size={16} />
          返回工作台
        </Link>
        <Button onPress={() => void router.invalidate()}>重新加载</Button>
      </div>
    </div>
  );
}

export function RouteNotFound() {
  return (
    <div className="py-20 text-center">
      <p className="text-sm text-muted-foreground">404 / PAGE NOT FOUND</p>
      <h1 className="mt-3 text-2xl font-semibold">这里还没有内容</h1>
      <Link
        to="/conversations"
        className={buttonVariants({ variant: 'outline', className: 'mt-6' })}
      >
        返回工作台
      </Link>
    </div>
  );
}
