import { createFileRoute } from "@tanstack/react-router";
import { safeReturnTo } from "@/features/auth";
import { LoginPage } from "@/pages/login/login-page";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({ redirect: safeReturnTo(search.redirect) }),
  component: LoginPage,
});
