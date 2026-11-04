import { QueryClientProvider } from "@tanstack/react-query";
import { Toast } from "@heroui/react";
import type { ReactNode } from "react";
import { AuthProvider } from "@/features/auth";
import { queryClient } from "./query-client";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Toast.Provider placement="top" />
        {children}
      </AuthProvider>
    </QueryClientProvider>
  );
}
