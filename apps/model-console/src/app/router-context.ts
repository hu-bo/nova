import type { QueryClient } from "@tanstack/react-query";
import type { AuthContextValue } from "@/features/auth";

export interface RouterContext {
  queryClient: QueryClient;
  auth: AuthContextValue;
}
