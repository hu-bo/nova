import { CasdoorProvider, useCasdoor } from "@nova/casdoor/client/react";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  userId?: string | null;
  displayName: string | null;
  error: Error | null;
  login: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const config = {
  appName: "nova",
  authApiBase: "//auth.8and1.cn/api",
  redirectUri: `${window.location.origin}/callback`,
  logoutRedirectUri: window.location.origin,
  storage: {
    type: "localStorage" as const,
    prefix: "nova_",
    accessTokenKey: "access_token",
  },
  silentRefresh: true,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <CasdoorProvider config={config}>
      <AuthBridge>{children}</AuthBridge>
    </CasdoorProvider>
  );
}

function AuthBridge({ children }: { children: ReactNode }) {
  const auth = useCasdoor();
  useEffect(() => {
    window.addEventListener("nova:unauthorized", auth.logout);
    return () => window.removeEventListener("nova:unauthorized", auth.logout);
  }, [auth.logout]);
  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated: auth.isAuthenticated,
      isLoading: auth.isLoading,
      displayName: auth.user?.displayName || auth.user?.name || null,
      error: auth.error,
      login: auth.login,
      logout: auth.logout,
    }),
    [auth.isAuthenticated, auth.isLoading, auth.user, auth.error, auth.login, auth.logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
