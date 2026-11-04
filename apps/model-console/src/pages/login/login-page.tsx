import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { LoginRedirect, useAuth } from "@/features/auth";

const loginRoute = getRouteApi("/login");

export function LoginPage() {
  const { redirect } = loginRoute.useSearch();
  const auth = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (auth.isAuthenticated) void router.navigate({ href: redirect, replace: true });
  }, [auth.isAuthenticated, router, redirect]);
  return <LoginRedirect returnTo={redirect} />;
}
