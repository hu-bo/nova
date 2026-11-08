import { Bot, CircleAlert, LoaderCircle, RotateCcw, UserRound } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useRef, type ReactNode, type UIEvent } from "react";
import { BlockView } from "./block-view.js";
import { ToolBlock } from "./blocks/tool.js";
import type { Block, BlockRenderers, ChatMessage, ExtractBlock } from "./types.js";
import { Button } from "./components/ui/button.js";
import { CopyButton } from "./components/copy-button.js";

export interface MessageListScrollState {
  scrollTop: number;
  followsBottom: boolean;
}

export interface MessageListProps {
  messages: ChatMessage[];
  showToolCalls?: boolean;
  renderers?: BlockRenderers | undefined;
  onRetry?: ((messageId: string) => void) | undefined;
  onOpenPath?: ((path: string, line?: number) => void) | undefined;
  initialScrollState?: MessageListScrollState | undefined;
  onScrollStateChange?: ((state: MessageListScrollState) => void) | undefined;
}

function renderBlocks(
  blocks: Block[],
  renderers?: BlockRenderers,
  onOpenPath?: MessageListProps["onOpenPath"],
): ReactNode[] {
  const consumed = new Set<number>();
  const nodes: ReactNode[] = [];

  blocks.forEach((block, index) => {
    if (consumed.has(index)) return;
    if (block.type !== "tool_call") {
      if (block.type === "tool_result" && block.blocks.length === 0) return;
      nodes.push(
        <BlockView
          block={block}
          renderers={renderers}
          {...(onOpenPath ? { onOpenPath } : {})}
          key={block.id ?? index}
        />,
      );
      return;
    }

    const resultIndex = blocks.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index && candidate.type === "tool_result" && candidate.callId === block.callId,
    );
    const result = resultIndex >= 0 ? (blocks[resultIndex] as ExtractBlock<"tool_result">) : undefined;
    if (resultIndex >= 0) consumed.add(resultIndex);

    nodes.push(
      <ToolBlock
        call={block}
        result={result}
        renderDiff={(diff, diffIndex) => (
          <BlockView block={diff} renderers={renderers} onOpenPath={onOpenPath} key={diff.id ?? diffIndex} />
        )}
        key={block.id ?? index}
      />,
    );
  });

  return nodes;
}

/**
 * Protocol messages keep a `tool_result` in its own "tool" message while the matching `tool_call`
 * lives in the preceding assistant message. Pair them across messages so the result renders inside
 * the collapsible tool block instead of as a standalone raw dump. Unchanged messages keep identity.
 */
const pairedViews = new WeakMap<ChatMessage, ChatMessage>();
function pairToolResults(messages: ChatMessage[]): ChatMessage[] {
  const callOwner = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const block of message.blocks) if (block.type === "tool_call") callOwner.set(block.callId, index);
  });
  const additions = new Map<number, Map<string, Block[]>>();
  const moved = new Map<number, Set<number>>();
  messages.forEach((message, index) => {
    message.blocks.forEach((block, blockIndex) => {
      if (block.type !== "tool_result") return;
      const owner = callOwner.get(block.callId);
      if (owner === undefined || owner === index) return;
      const byCall = additions.get(owner) ?? new Map<string, Block[]>();
      byCall.set(block.callId, [...(byCall.get(block.callId) ?? []), block]);
      additions.set(owner, byCall);
      const removed = moved.get(index) ?? new Set<number>();
      removed.add(blockIndex);
      moved.set(index, removed);
    });
  });
  if (additions.size === 0) return messages;
  return messages
    .map((message, index) => {
      const removed = moved.get(index);
      const byCall = additions.get(index);
      if (!removed && !byCall) return message;
      const blocks: Block[] = [];
      message.blocks.forEach((block, blockIndex) => {
        if (removed?.has(blockIndex)) return;
        blocks.push(block);
        if (block.type === "tool_call") {
          const results = byCall?.get(block.callId);
          if (results) blocks.push(...results);
        }
      });
      const prior = pairedViews.get(message);
      if (
        prior &&
        prior.blocks.length === blocks.length &&
        prior.blocks.every((block, index) => block === blocks[index])
      )
        return prior;
      const paired = { ...message, blocks };
      pairedViews.set(message, paired);
      return paired;
    })
    .filter((message, index) => (moved.get(index)?.size ?? 0) === 0 || message.blocks.length > 0);
}

const MessageRow = memo(function MessageRow({
  message,
  renderers,
  onRetry,
  onOpenPath,
  showToolCalls,
}: {
  message: ChatMessage;
  renderers?: BlockRenderers | undefined;
  onRetry?: MessageListProps["onRetry"];
  onOpenPath?: MessageListProps["onOpenPath"];
  showToolCalls: boolean;
}) {
  const blocks = showToolCalls
    ? message.blocks
    : message.blocks.filter((block) => block.type !== "tool_call" && block.type !== "tool_result");
  if (
    (message.blocks.length > 0 || message.role === "tool") &&
    blocks.every((block) => block.type === "tool_result" && block.blocks.length === 0)
  )
    return null;

  const isUser = message.role === "user";
  const hasFailed = message.status === "error" || message.status === "aborted";
  const userText = isUser
    ? message.blocks
        .filter((block): block is ExtractBlock<"text"> => block.type === "text")
        .map((block) => block.text)
        .join("\n\n")
    : "";

  return (
    <article
      data-message-id={message.id}
      data-role={message.role}
      aria-busy={message.status === "streaming"}
      className={
        isUser
          ? "group ml-auto w-fit max-w-[min(88%,48rem)] rounded-2xl rounded-br-md bg-slate-100 px-3.5 py-2.5 text-slate-900 ring-1 ring-slate-200/70 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700/70"
          : "group w-full py-1 text-slate-900 dark:text-slate-100"
      }
    >
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
          <span className="grid size-5 place-items-center rounded-md bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
            {isUser ? (
              <UserRound className="size-3" aria-hidden="true" />
            ) : (
              <Bot className="size-3" aria-hidden="true" />
            )}
          </span>
          <span>{isUser ? "You" : message.role === "tool" ? "工具" : "Nova"}</span>
          {message.status === "streaming" && (
            <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-label="正在生成" />
          )}
        </div>
        {userText && <CopyButton text={userText} label="复制消息" className="-my-1 text-slate-400" />}
      </div>
      <div className="grid min-w-0 gap-2">{renderBlocks(blocks, renderers, onOpenPath)}</div>
      {hasFailed && (
        <div className="mt-2 flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400">
          <CircleAlert className="size-3.5" aria-hidden="true" />
          <span>{message.status === "aborted" ? "生成已中断" : "消息生成失败"}</span>
          {onRetry && (
            <Button type="button" variant="destructive" size="xs" onClick={() => onRetry(message.id)} className="ml-1">
              <RotateCcw aria-hidden="true" />
              重试
            </Button>
          )}
        </div>
      )}
    </article>
  );
});

export function MessageList({
  messages,
  showToolCalls = true,
  renderers,
  onRetry,
  onOpenPath,
  initialScrollState,
  onScrollStateChange,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollState = useRef(initialScrollState ?? { scrollTop: 0, followsBottom: true });
  const onScrollStateChangeRef = useRef(onScrollStateChange);
  const callbacks = useRef({ onRetry, onOpenPath });
  useLayoutEffect(() => {
    callbacks.current = { onRetry, onOpenPath };
  }, [onRetry, onOpenPath]);
  const retry = useCallback((id: string) => callbacks.current.onRetry?.(id), []);
  const openPath = useCallback((path: string, line?: number) => callbacks.current.onOpenPath?.(path, line), []);

  useLayoutEffect(() => {
    onScrollStateChangeRef.current = onScrollStateChange;
  }, [onScrollStateChange]);

  function trackScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    scrollState.current = {
      scrollTop: element.scrollTop,
      followsBottom: element.scrollHeight - element.scrollTop - element.clientHeight < 48,
    };
    onScrollStateChangeRef.current?.(scrollState.current);
  }

  useLayoutEffect(() => {
    const container = containerRef.current!;
    const content = contentRef.current!;
    // Restore before paint; route remounts must not animate through the history.
    container.scrollTop = scrollState.current.followsBottom ? container.scrollHeight : scrollState.current.scrollTop;

    const saveScrollState = () => {
      scrollState.current = { ...scrollState.current, scrollTop: container.scrollTop };
      onScrollStateChangeRef.current?.(scrollState.current);
    };
    saveScrollState();

    // The composer changing height resizes this scroller, so the callback must not read layout: a
    // `scrollHeight` read here reflows every message node on each keystroke. Letting the scroller
    // resolve an overflowing offset pins it to the bottom without the read, and the frame
    // coalescing keeps a streaming resize to one scroll per frame.
    let pendingFrame = 0;
    const observer = new ResizeObserver(() => {
      if (!scrollState.current.followsBottom || pendingFrame) return;
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = 0;
        container.scrollTo(0, Number.MAX_SAFE_INTEGER);
      });
    });
    observer.observe(container);
    observer.observe(content);

    return () => {
      observer.disconnect();
      if (pendingFrame) cancelAnimationFrame(pendingFrame);
      saveScrollState();
    };
  }, []);

  const pairedMessages = showToolCalls ? pairToolResults(messages) : messages;

  return (
    <div
      ref={containerRef}
      onScroll={trackScroll}
      className="nova-message-list nova-scrollbar flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden overscroll-contain px-1 pb-2 [scrollbar-gutter:stable]"
      aria-live="polite"
    >
      <div ref={contentRef} className="nova-chat-content space-y-3">
        {pairedMessages.map((message) => (
          <MessageRow
            message={message}
            showToolCalls={showToolCalls}
            renderers={renderers}
            onRetry={onRetry ? retry : undefined}
            onOpenPath={onOpenPath ? openPath : undefined}
            key={message.id}
          />
        ))}
      </div>
    </div>
  );
}
