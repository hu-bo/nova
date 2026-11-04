import { CasdoorProvider, useCasdoor, useCasdoorClient } from "@nova/casdoor/client/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { configureSession } from "@/api/session";
import { AuthContext } from "./auth-context";

const config = {
  appName: import.meta.env.VITE_AUTH_APP_NAME || "nova",
  authApiBase: import.meta.env.VITE_AUTH_BASE_URL || "//auth.8and1.cn/api",
  redirectUri: `${window.location.origin}/callback`,
  storage: {
    type: "sessionStorage" as const,
    prefix: "nova_console_",
  },
  silentRefresh: true,
};

export function CasdoorAuthProvider({ children }: { children: ReactNode }) {
  return (
    <CasdoorProvider config={config}>
      <AuthBridge>{children}</AuthBridge>
    </CasdoorProvider>
  );
}

function AuthBridge({ children }: { children: ReactNode }) {
  const auth = useCasdoor();
  const client = useCasdoorClient();
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const cleanup = configureSession({
      token: () => client.getState().accessToken,
      refresh: () => client.refreshToken(),
      logout: () => client.logout(),
    });
    setReady(true);
    return cleanup;
  }, [client]);
  useEffect(() => {
    void queryClient.cancelQueries();
    queryClient.clear();
  }, [auth.user?.id, queryClient]);
  const value = useMemo(
    () => ({
      isAuthenticated: auth.isAuthenticated,
      isLoading: auth.isLoading,
      userId: auth.user?.id ?? null,
      displayName: auth.user?.displayName || auth.user?.name || null,
      error: auth.error,
      login: auth.login,
      logout: auth.logout,
    }),
    [auth.isAuthenticated, auth.isLoading, auth.user, auth.error, auth.login, auth.logout],
  );
  return <AuthContext.Provider value={value}>{ready ? children : null}</AuthContext.Provider>;
}
