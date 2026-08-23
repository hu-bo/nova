import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { queryKeys } from "../api/query-keys.js";
import { useAuth } from "../auth/provider.js";

export function RunnerLiveUpdates() {
  const { api } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = async () => {
      try {
        const response = await fetch("/api/runners/events", {
          headers: { Authorization: `Bearer ${api.accessToken}` },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error("Runner event stream unavailable");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!disposed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (frame.split("\n").some(line => line.startsWith("data:"))) {
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.runners }),
                queryClient.invalidateQueries({ queryKey: queryKeys.runnerTokens }),
                queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
              ]);
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
        if (!disposed) throw new Error("Runner event stream closed");
      } catch {
        if (!disposed && !controller.signal.aborted) retry = setTimeout(() => void connect(), 2_000);
      }
    };
    void connect();
    return () => {
      disposed = true;
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [api, queryClient]);

  return null;
}
