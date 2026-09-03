import { Bot, CircleAlert, LoaderCircle, RotateCcw, UserRound } from "lucide-react";
import { memo, useEffect, useRef, type ReactNode, type UIEvent } from "react";
import type { Block, ChatMessage } from "@nova/protocol";
import { BlockView } from "./block-view.js";
import { ToolBlock } from "./blocks/tool.js";
import type { BlockRenderers, ExtractBlock } from "./types.js";
import { Button } from "./components/ui/button.js";
import { CopyButton } from "./components/copy-button.js";

export interface MessageListProps {
  messages: ChatMessage[];
  renderers?: BlockRenderers | undefined;
  onRetry?: ((messageId: string) => void) | undefined;
  onOpenPath?: ((path: string, line?: number) => void) | undefined;
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
      nodes.push(<BlockView block={block} renderers={renderers} {...(onOpenPath ? { onOpenPath } : {})} key={index} />);
      return;
    }

    const resultIndex = blocks.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index && candidate.type === "tool_result" && candidate.callId === block.callId,
    );
    const result = resultIndex >= 0 ? (blocks[resultIndex] as ExtractBlock<"tool_result">) : undefined;
    if (resultIndex >= 0) consumed.add(resultIndex);

    if (block.name === "todo_write") {
      result?.blocks.forEach((child, childIndex) =>
        nodes.push(
          <BlockView
            block={child}
            renderers={renderers}
            {...(onOpenPath ? { onOpenPath } : {})}
            key={`${index}-${childIndex}`}
          />,
        ),
      );
      return;
    }

    nodes.push(<ToolBlock call={block} {...(result ? { result } : {})} key={index} />);
  });

  return nodes;
}

const MessageRow = memo(function MessageRow({
  message,
  renderers,
  onRetry,
  onOpenPath,
}: {
  message: ChatMessage;
  renderers?: BlockRenderers | undefined;
  onRetry?: MessageListProps["onRetry"];
  onOpenPath?: MessageListProps["onOpenPath"];
}) {
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
          : "group w-full max-w-4xl py-1 text-slate-900 dark:text-slate-100"
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
          <span>{isUser ? "You" : "Nova"}</span>
          {message.status === "streaming" && (
            <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" aria-label="正在生成" />
          )}
        </div>
        {userText && <CopyButton text={userText} label="复制消息" className="-my-1 text-slate-400" />}
      </div>
      <div className="grid min-w-0 gap-2">{renderBlocks(message.blocks, renderers, onOpenPath)}</div>
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

export function MessageList({ messages, renderers, onRetry, onOpenPath }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const followsBottom = useRef(true);

  function trackScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    followsBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  }

  useEffect(() => {
    if (followsBottom.current)
      containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  return (
    <div
      ref={containerRef}
      onScroll={trackScroll}
      className="nova-message-list nova-scrollbar flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden overscroll-contain px-1 pb-2 [scrollbar-gutter:stable]"
      aria-live="polite"
    >
      <div className="mx-auto w-full max-w-4xl space-y-3">
        {messages.map((message) => (
          <MessageRow
            message={message}
            renderers={renderers}
            onRetry={onRetry}
            onOpenPath={onOpenPath}
            key={message.id}
          />
        ))}
      </div>
    </div>
  );
}
