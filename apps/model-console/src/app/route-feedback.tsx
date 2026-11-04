import { Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export function RoutePending() {
  return (
    <main className="min-h-screen bg-background p-5 sm:p-8 lg:p-10" role="status" aria-label="正在加载页面">
      <span className="sr-only">正在加载页面</span>
      <div className="mx-auto grid max-w-[1600px] animate-pulse gap-8 motion-reduce:animate-none">
        <div className="grid max-w-xl gap-3">
          <div className="h-3 w-32 rounded-full bg-slate-200" />
          <div className="h-8 w-3/4 rounded-lg bg-slate-200" />
          <div className="h-3 w-full rounded-full bg-slate-200" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div className="h-32 rounded-xl bg-surface ring-1 ring-border" key={index} />
          ))}
        </div>
        <div className="h-72 rounded-xl bg-surface ring-1 ring-border" />
      </div>
    </main>
  );
}

export function RouteError({ reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <section className="text-center" role="alert">
        <h1 className="text-xl font-semibold">页面加载失败</h1>
        <p className="mt-2 text-sm text-muted-foreground">请重试，或返回后台首页。</p>
        <div className="mt-6 flex justify-center gap-3">
          <Button
            onPress={() => {
              void router.invalidate().then(reset);
            }}
          >
            重试
          </Button>
          <Link to="/providers">返回首页</Link>
        </div>
      </section>
    </main>
  );
}

export function RouteNotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <section className="text-center">
        <h1 className="text-xl font-semibold">页面不存在</h1>
        <Link to="/providers" className="mt-4 inline-block text-accent">
          返回模型配置后台
        </Link>
      </section>
    </main>
  );
}
