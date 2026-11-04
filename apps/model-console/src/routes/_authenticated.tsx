import { createFileRoute, redirect } from "@tanstack/react-router";
import { ConsoleLayout } from "@/app/layouts/console-layout";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: ({ context, location }) => {
    if (!context.auth.isAuthenticated) {
      throw redirect({ to: "/login", search: { redirect: location.href }, replace: true });
    }
  },
  component: ConsoleLayout,
});
