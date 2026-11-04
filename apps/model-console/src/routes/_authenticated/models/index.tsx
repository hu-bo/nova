import { createFileRoute } from "@tanstack/react-router";
import { ModelsPage } from "@/pages/models/models-page";

export const Route = createFileRoute("/_authenticated/models/")({ component: ModelsPage });
