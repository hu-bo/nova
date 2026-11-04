import { createFileRoute } from "@tanstack/react-router";
import { usageSearchSchema } from "@/features/usage";
import { UsagePage } from "@/pages/usage/usage-page";

export const Route = createFileRoute("/_authenticated/usage/")({
  validateSearch: usageSearchSchema,
  component: UsagePage,
});
