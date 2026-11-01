import { DEV_MOCK_USER } from "@nova/agent-ui-contracts/dev-auth";
import { developmentAuthEnabled } from "./session.js";
import { createContext, lazy, Suspense, useContext, type ReactNode } from "react";

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  userId?: string | null;
  displayName: string | null;
  error: Error | null;
  login: () => Promise<void>;
  logout: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

const CasdoorAuthProvider = lazy(() =>
  import("./casdoor-provider.js").then((module) => ({ default: module.CasdoorAuthProvider })),
);

const developmentAuth: AuthContextValue = {
  isAuthenticated: true,
  isLoading: false,
  userId: DEV_MOCK_USER.casdoorId,
  displayName: DEV_MOCK_USER.displayName,
  error: null,
  login: async () => undefined,
  logout: () => undefined,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  if (developmentAuthEnabled) return <AuthContext.Provider value={developmentAuth}>{children}</AuthContext.Provider>;
  return (
    <Suspense
      fallback={<div className="grid min-h-screen place-items-center text-sm text-slate-500">正在连接身份服务…</div>}
    >
      <CasdoorAuthProvider>{children}</CasdoorAuthProvider>
    </Suspense>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
