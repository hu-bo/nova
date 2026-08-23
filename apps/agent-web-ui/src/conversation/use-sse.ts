import { UiEventSchema, type ChatMessage, type UiEvent } from "@nova/protocol";
import { useEffect, type Dispatch } from "react";
import type { ConversationAction } from "./reducer.js";

interface SseItem {
  id: string | null;
  event: UiEvent;
}

interface UseSseOptions {
  conversationId: string;
  accessToken: string;
  enabled: boolean;
  dispatch: Dispatch<ConversationAction>;
  loadSnapshot: () => Promise<ChatMessage[]>;
  onTerminal: () => void;
  onUnauthorized: () => void;
}

export function useSse({ conversationId, accessToken, enabled, dispatch, loadSnapshot, onTerminal, onUnauthorized }: UseSseOptions) {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let suspended = false;
    let controller: AbortController | null = null;
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
    let wake: (() => void) | null = null;
    let lastEventId: string | null = null;
    let retry = 0;
    const seen = new Set<string>();
    const seenOrder: string[] = [];

    const wakeNow = () => {
      controller?.abort();
      wake?.();
      wake = null;
    };

    const wait = (milliseconds: number) => new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, milliseconds);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

    const remember = (id: string) => {
      if (seen.has(id)) return false;
      seen.add(id);
      seenOrder.push(id);
      if (seenOrder.length > 1_000) {
        const removed = seenOrder.shift();
        if (removed) seen.delete(removed);
      }
      return true;
    };

    const run = async () => {
      while (!disposed) {
        if (suspended || !navigator.onLine) {
          dispatch({ type: "connection", connection: "closed" });
          await wait(60_000);
          continue;
        }

        dispatch({ type: "connection", connection: retry === 0 ? "connecting" : "reconnecting" });
        controller = new AbortController();
        try {
          const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
          if (lastEventId) headers["Last-Event-ID"] = lastEventId;
          const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/events`, {
            headers,
            signal: controller.signal,
          });
          if (response.status === 401) {
            onUnauthorized();
            return;
          }
          if (!response.ok) throw new Error(`SSE connection failed (${response.status})`);
          dispatch({ type: "connection", connection: "open" });
          dispatch({ type: "clear-error" });
          retry = 0;

          for await (const item of parseSse(response.body)) {
            if (disposed) return;
            if (item.event.type === "error" && item.event.code === "RESYNC") {
              const messages = await loadSnapshot();
              seen.clear();
              seenOrder.length = 0;
              lastEventId = null;
              dispatch({ type: "hydrate", messages });
              break;
            }
            if (item.id) {
              lastEventId = item.id;
              if (!remember(item.id)) continue;
            }
            dispatch({ type: "event", event: item.event, conversationId });
            if (item.event.type === "message.end" || item.event.type === "run.end") onTerminal();
          }
        } catch (error) {
          if (!controller.signal.aborted && !disposed) {
            dispatch({ type: "event", conversationId, event: {
              type: "error",
              code: "SSE_DISCONNECTED",
              message: error instanceof Error ? error.message : "实时连接已断开",
            } });
          }
        } finally {
          controller = null;
        }

        if (disposed) return;
        retry += 1;
        dispatch({ type: "connection", connection: "reconnecting" });
        const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(retry - 1, 5));
        await wait(Math.round(backoff * (0.8 + Math.random() * 0.4)));
      }
    };

    const visibility = () => {
      if (document.hidden) {
        if (hiddenTimer) clearTimeout(hiddenTimer);
        hiddenTimer = setTimeout(() => {
          suspended = true;
          wakeNow();
        }, 5 * 60_000);
      } else {
        if (hiddenTimer) clearTimeout(hiddenTimer);
        hiddenTimer = null;
        if (suspended) {
          suspended = false;
          wakeNow();
        }
      }
    };
    const online = () => wakeNow();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", online);
    void run();

    return () => {
      disposed = true;
      controller?.abort();
      wake?.();
      if (hiddenTimer) clearTimeout(hiddenTimer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
      dispatch({ type: "connection", connection: "closed" });
    };
  }, [accessToken, conversationId, dispatch, enabled, loadSnapshot, onTerminal, onUnauthorized]);
}

async function* parseSse(stream: ReadableStream<Uint8Array> | null): AsyncGenerator<SseItem> {
  if (!stream) throw new Error("服务器未返回事件流");
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): SseItem | null {
  let id: string | null = null;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "id") id = value;
    if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  return { id, event: UiEventSchema.parse(JSON.parse(data.join("\n"))) };
}
