import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { AuthProvider } from "./auth/provider.js";
import { ModelSettingsProvider } from "./pages/settings/model/provider.js";
import { AppRouter } from "./routers/index.js";

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
          <AppRouter />
        </ModelSettingsProvider>
      </QueryClientProvider>
    </AuthProvider>
  );
}
