import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/provider.js";
import { RequireAuth } from "./auth/requireAuth.js";

const AppShell = lazy(() => import("./routes/app-shell.js").then((module) => ({ default: module.AppShell })));
const CallbackRoute = lazy(() => import("./routes/callback.js").then((module) => ({ default: module.CallbackRoute })));
const ProvidersRoute = lazy(() =>
  import("./routes/providers.js").then((module) => ({ default: module.ProvidersRoute })),
);
const ModelsRoute = lazy(() => import("./routes/models.js").then((module) => ({ default: module.ModelsRoute })));
// const KeysRoute = lazy(() => import("./routes/keys.js").then(module => ({ default: module.KeysRoute })));
const UsageRoute = lazy(() => import("./routes/usage.js").then((module) => ({ default: module.UsageRoute })));
const QuotasRoute = lazy(() => import("./routes/quotas.js").then((module) => ({ default: module.QuotasRoute })));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: true }, mutations: { retry: false } },
});

export function App() {
  useEffect(() => {
    const boot = document.getElementById("nova-boot");
    if (!boot) return;
    let removeTimer: number | undefined;
    const frame = requestAnimationFrame(() => {
      boot.setAttribute("data-ready", "");
      removeTimer = window.setTimeout(() => boot.remove(), 180);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (removeTimer !== undefined) clearTimeout(removeTimer);
    };
  }, []);

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route
              path="/callback"
              element={
                <LazyPage>
                  <CallbackRoute />
                </LazyPage>
              }
            />
            <Route
              element={
                <RequireAuth>
                  <LazyPage>
                    <AppShell />
                  </LazyPage>
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="/providers" replace />} />
              <Route
                path="/providers"
                element={
                  <LazyPage>
                    <ProvidersRoute />
                  </LazyPage>
                }
              />
              <Route
                path="/models"
                element={
                  <LazyPage>
                    <ModelsRoute />
                  </LazyPage>
                }
              />
              <Route
                path="/usage"
                element={
                  <LazyPage>
                    <UsageRoute />
                  </LazyPage>
                }
              />
              <Route
                path="/quotas"
                element={
                  <LazyPage>
                    <QuotasRoute />
                  </LazyPage>
                }
              />
            </Route>
            <Route path="*" element={<Navigate to="/providers" replace />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </AuthProvider>
  );
}

function LazyPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;
}

function PageSkeleton() {
  return (
    <main className="min-h-screen bg-slate-50 p-5 sm:p-8 lg:p-10" role="status" aria-label="正在加载页面">
      <span className="sr-only">正在加载页面</span>
      <div className="mx-auto grid max-w-[1600px] animate-pulse gap-8 motion-reduce:animate-none">
        <div className="grid max-w-xl gap-3">
          <div className="h-3 w-32 rounded-full bg-slate-200" />
          <div className="h-8 w-3/4 rounded-lg bg-slate-200" />
          <div className="h-3 w-full rounded-full bg-slate-200" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div className="h-32 rounded-xl bg-white ring-1 ring-slate-200" key={index} />
          ))}
        </div>
        <div className="grid gap-8 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="h-72 rounded-xl bg-white ring-1 ring-slate-200" />
          <div className="h-72 rounded-xl bg-white ring-1 ring-slate-200" />
        </div>
      </div>
    </main>
  );
}
