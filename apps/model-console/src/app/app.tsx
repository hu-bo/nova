import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/features/auth";
import { AppProviders } from "./providers";
import { queryClient } from "./query-client";
import { createAppRouter } from "./router";
import { RoutePending } from "./route-feedback";

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
    <AppProviders>
      <AppRouter />
    </AppProviders>
  );
}

function AppRouter() {
  const auth = useAuth();
  const [router] = useState(() => createAppRouter({ queryClient, auth }));
  const [initialized, setInitialized] = useState(!auth.isLoading);
  useEffect(() => {
    // Keep the callback mounted when the SDK starts exchanging its code.
    if (!auth.isLoading) setInitialized(true);
  }, [auth.isLoading]);
  useEffect(() => {
    // Re-run route guards when the SDK restores, expires, or switches the session.
    void router.invalidate();
  }, [router, auth.isAuthenticated, auth.userId]);
  if (!initialized) return <RoutePending />;
  return <RouterProvider router={router} context={{ auth }} />;
}
