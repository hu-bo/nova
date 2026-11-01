import { AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Button } from "../components/ui/button.js";
import { LoadingState } from "../components/ui/feedback.js";
import { useAuth } from "./provider.js";

export function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  const requested = useRef(false);
  const [loginError, setLoginError] = useState<Error | null>(null);

  useEffect(() => {
    if (auth.isLoading || auth.isAuthenticated || requested.current) return;
    requested.current = true;
    sessionStorage.setItem("nova_return_to", `${location.pathname}${location.search}`);
    void auth.login().catch((error) => {
      requested.current = false;
      setLoginError(error instanceof Error ? error : new Error("无法发起登录"));
    });
  }, [auth, location.pathname, location.search]);

  if (auth.isAuthenticated) return children;
  const error = auth.error ?? loginError;
  if (error) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <section className="w-full max-w-md rounded-2xl bg-surface p-8 text-center ring-1 ring-border">
          <AlertTriangle className="mx-auto size-9 text-danger" aria-hidden="true" />
          <h1 className="mt-4 text-xl font-semibold text-foreground">登录失败</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{error.message}</p>
          <Button
            variant="primary"
            className="mt-6"
            onPress={() => {
              setLoginError(null);
              requested.current = false;
              void auth
                .login()
                .catch((loginFailure) =>
                  setLoginError(loginFailure instanceof Error ? loginFailure : new Error("无法发起登录")),
                );
            }}
          >
            重新登录
          </Button>
        </section>
      </main>
    );
  }
  return (
    <main className="min-h-screen bg-background p-5 sm:p-8 lg:p-10">
      <div className="mx-auto max-w-3xl">
        <LoadingState label="正在安全登录" />
      </div>
    </main>
  );
}