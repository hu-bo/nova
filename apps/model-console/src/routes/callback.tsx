import { createFileRoute, redirect } from "@tanstack/react-router";
import { developmentAuthEnabled } from "@/api/session";
import { CallbackPage } from "@/pages/callback/callback-page";

export const Route = createFileRoute("/callback")({
  beforeLoad: () => {
    if (developmentAuthEnabled) throw redirect({ to: "/providers", replace: true });
  },
  component: CallbackPage,
});
