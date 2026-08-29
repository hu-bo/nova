import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "../auth/requireAuth.js";

const AppShell = lazy(() => import("../pages/app-shell.js").then((module) => ({ default: module.AppShell })));
const CallbackRoute = lazy(() => import("../pages/callback.js").then((module) => ({ default: module.CallbackRoute })));
const ConversationRoute = lazy(() =>
  import("../pages/conversation.js").then((module) => ({ default: module.ConversationRoute })),
);
const HomeRoute = lazy(() => import("../pages/home.js").then((module) => ({ default: module.HomeRoute })));
const LandingRoute = lazy(() => import("../pages/landing.js").then((module) => ({ default: module.LandingRoute })));
const ProjectRoute = lazy(() =>
  import("../pages/project/index.js").then((module) => ({ default: module.ProjectRoute })),
);
const SettingsRoute = lazy(() =>
  import("../pages/settings/index.js").then((module) => ({ default: module.SettingsRoute })),
);
const RunnerManagementPage = lazy(() =>
  import("../pages/settings/runner/index.js").then((module) => ({ default: module.RunnerManagementPage })),
);

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <LazyPage>
              <LandingRoute />
            </LazyPage>
          }
        />
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
          <Route
            path="/app"
            element={
              <LazyPage>
                <HomeRoute />
              </LazyPage>
            }
          />
          <Route
            path="/p/:projectId"
            element={
              <LazyPage>
                <ProjectRoute />
              </LazyPage>
            }
          />
          <Route
            path="/p/:projectId/c/:conversationId"
            element={
              <LazyPage>
                <ConversationRoute />
              </LazyPage>
            }
          />
          <Route
            path="/c/:conversationId"
            element={
              <LazyPage>
                <ConversationRoute />
              </LazyPage>
            }
          />
          <Route
            path="/settings"
            element={
              <LazyPage>
                <SettingsRoute />
              </LazyPage>
            }
          />
          <Route
            path="/settings/runners"
            element={
              <LazyPage>
                <RunnerManagementPage />
              </LazyPage>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function LazyPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageSkeleton />}>{children}</Suspense>;
}

function PageSkeleton() {
  return (
    <main className="min-h-screen bg-slate-50 p-6" role="status" aria-label="正在加载页面">
      <span className="sr-only">正在加载页面</span>
    </main>
  );
}
