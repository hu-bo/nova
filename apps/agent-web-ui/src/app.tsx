import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/provider.js";
import { ModelSettingsProvider } from "./model/provider.js";
import { RequireAuth } from "./auth/requireAuth.js";

const AppShell = lazy(() => import("./routes/app-shell.js").then(module => ({ default: module.AppShell })));
const CallbackRoute = lazy(() => import("./routes/callback.js").then(module => ({ default: module.CallbackRoute })));
const ConversationRoute = lazy(() => import("./routes/conversation.js").then(module => ({ default: module.ConversationRoute })));
const HomeRoute = lazy(() => import("./routes/home.js").then(module => ({ default: module.HomeRoute })));
const LandingRoute = lazy(() => import("./routes/landing.js").then(module => ({ default: module.LandingRoute })));
const ProjectRoute = lazy(() => import("./routes/project.js").then(module => ({ default: module.ProjectRoute })));
const SettingsRoute = lazy(() => import("./routes/settings.js").then(module => ({ default: module.SettingsRoute })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
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
        <ModelSettingsProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<LazyPage><LandingRoute /></LazyPage>} />
              <Route path="/callback" element={<LazyPage><CallbackRoute /></LazyPage>} />
              <Route element={<RequireAuth><LazyPage><AppShell /></LazyPage></RequireAuth>}>
                <Route path="/app" element={<LazyPage><HomeRoute /></LazyPage>} />
                <Route path="/p/:projectId" element={<LazyPage><ProjectRoute /></LazyPage>} />
                <Route path="/p/:projectId/c/:conversationId" element={<LazyPage><ConversationRoute /></LazyPage>} />
                <Route path="/c/:conversationId" element={<LazyPage><ConversationRoute /></LazyPage>} />
                <Route path="/settings" element={<LazyPage><SettingsRoute /></LazyPage>} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </ModelSettingsProvider>
      </QueryClientProvider>
    </AuthProvider>
  );
}


function LazyPage({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      {children}
    </Suspense>
  );
}

function PageSkeleton() {
  return (
    <main className="min-h-screen bg-slate-50 p-5 sm:p-6 lg:p-8" role="status" aria-label="正在加载页面">
      <span className="sr-only">正在加载页面</span>
      <div className="mx-auto grid max-w-[1500px] animate-pulse gap-8 motion-reduce:animate-none">
        <div className="grid max-w-xl gap-3">
          <div className="h-3 w-32 rounded-full bg-slate-200" />
          <div className="h-8 w-3/4 rounded-lg bg-slate-200" />
          <div className="h-3 w-full rounded-full bg-slate-200" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => <div className="h-32 rounded-xl bg-white ring-1 ring-slate-200" key={index} />)}
        </div>
        <div className="grid gap-8 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="h-72 rounded-xl bg-white ring-1 ring-slate-200" />
          <div className="h-72 rounded-xl bg-white ring-1 ring-slate-200" />
        </div>
      </div>
    </main>
  );
}
