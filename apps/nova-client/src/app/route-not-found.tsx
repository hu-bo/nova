import { buttonVariants } from '@/components/ui/button-variants';
import { Link } from '@tanstack/react-router';

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
