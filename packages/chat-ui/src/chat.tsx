import { AlertCircle, CornerDownLeft, CornerDownRight, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Composer } from "./composer.js";
import type { ComposerProps, ComposerSubmission } from "./composer-types.js";
import { DecisionPrompt } from "./decision-prompt.js";
import { MessageList, type MessageListProps } from "./message-list.js";
import { RemoteExplorer, type RemoteExplorerProps } from "./remote-explorer.js";
import { TodoPanel } from "./todo-panel.js";
import type { BlockRenderers, ChatMessage, DecisionRequest, DecisionResponse, Todo } from "./types.js";

export interface ChatQueuedMessage {
  id: string;
  text: string;
  isSteering?: boolean | undefined;
  canSteer?: boolean | undefined;
}

export interface ChatFeedback {
  id: string;
  message: string;
  tone: "error" | "warning" | "info";
  description?: string | undefined;
  action?: ReactNode | undefined;
  dismissible?: boolean | undefined;
}

export interface ChatState {
  messages: ChatMessage[];
  todos: Todo[];
  queuedMessages: ChatQueuedMessage[];
  pendingDecision?: DecisionRequest | null | undefined;
  approvalAutoConfirmInSeconds?: number | null | undefined;
  connection: "connecting" | "open" | "reconnecting" | "closed";
  isRunning: boolean;
  isAborting?: boolean | undefined;
  isResolvingDecision?: boolean | undefined;
  isSteeringQueuedMessage?: boolean | undefined;
  feedback?: ChatFeedback[] | undefined;
}

const connectionMessages = {
  connecting: "正在连接实时消息流",
  open: null,
  reconnecting: "实时消息流已断开，正在重连",
  closed: null,
} satisfies Record<ChatState["connection"], string | null>;

export type ChatComposerConfig<TMetadata = unknown> = Omit<
  ComposerProps<TMetadata>,
  "isRunning" | "isAborting" | "onAbort" | "onSubmit"
>;

export interface ChatActions<TMetadata = unknown> {
  onScrollStateChange?: MessageListProps["onScrollStateChange"];
  onSubmit: (submission: ComposerSubmission<TMetadata>) => void | boolean | Promise<void | boolean>;
  onAbort?: (() => void | Promise<void>) | undefined;
  onRetryMessage?: ((messageId: string) => void) | undefined;
  onResolveDecision: (response: DecisionResponse) => void | Promise<void>;
  onRemoveQueuedMessage?: ((messageId: string) => void) | undefined;
  onSteerQueuedMessage?: ((messageId: string) => void | Promise<void>) | undefined;
  onDismissFeedback?: ((id: string) => void) | undefined;
}

export interface ChatProps<TMetadata = unknown> {
  initialScrollState?: MessageListProps["initialScrollState"];
  showToolCalls?: boolean;
  state: ChatState;
  composer: ChatComposerConfig<TMetadata>;
  actions: ChatActions<TMetadata>;
  emptyState?: ReactNode | undefined;
  explorer?: RemoteExplorerProps | undefined;
  /** Passed through to `MessageList` so hosts can override block rendering (e.g. signed attachment images). */
  renderers?: BlockRenderers | undefined;
  /** Rendered in the desktop (xl) aside only; narrow screens keep the focused message view. */
  sidebar?: ReactNode | undefined;
  /** Hosts may let users hide context while retaining a focused message view. */
  sidebarOpen?: boolean | undefined;
}

const feedbackClasses: Record<ChatFeedback["tone"], string> = {
  error: "bg-rose-50 text-rose-700 ring-rose-200",
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
  info: "bg-indigo-50 text-indigo-800 ring-indigo-200",
};

export function Chat<TMetadata = unknown>({
  state,
  composer,
  actions,
  emptyState,
  explorer,
  initialScrollState,
  renderers,
  sidebar,
  sidebarOpen = true,
  showToolCalls = true,
}: ChatProps<TMetadata>) {
  const incompleteTodos = state.todos.filter((todo) => todo.status !== "completed").length;
  const hasSidebar = sidebarOpen && (Boolean(sidebar) || incompleteTodos > 0);
  const connectionMessage = connectionMessages[state.connection];
  const errorFeedback = state.feedback?.filter((feedback) => feedback.tone === "error") ?? [];
  const composerFeedback = state.feedback?.filter((feedback) => feedback.tone !== "error") ?? [];

  const onAbort = actions.onAbort;
  const messageAreaRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const messageArea = messageAreaRef.current;
    const composerDock = composerDockRef.current;
    if (!messageArea || !composerDock) return;

    const updateComposerHeight = () => {
      messageArea.style.setProperty("--nova-chat-composer-height", `${composerDock.getBoundingClientRect().height}px`);
    };
    updateComposerHeight();

    const observer = new ResizeObserver(updateComposerHeight);
    observer.observe(composerDock);
    return () => {
      observer.disconnect();
      messageArea.style.removeProperty("--nova-chat-composer-height");
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.repeat ||
        event.defaultPrevented ||
        !state.isRunning ||
        state.isAborting ||
        !onAbort ||
        document.querySelector('[role="dialog"]')
      )
        return;
      event.preventDefault();
      void onAbort();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onAbort, state.isAborting, state.isRunning]);

  return (
    <div
      className={`nova-chat nova-chat-view grid min-h-0 flex-1 overflow-hidden bg-white ${hasSidebar ? "xl:grid-cols-[minmax(0,1fr)_260px]" : ""}`}
    >
      <div ref={messageAreaRef} className="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-white">
        <div className="relative min-h-0 flex-1 overflow-hidden px-1 py-0 sm:py-1 sm:px-0">
          {state.messages.length ? (
            <MessageList
              messages={state.messages}
              showToolCalls={showToolCalls}
              renderers={renderers}
              initialScrollState={initialScrollState}
              onScrollStateChange={actions.onScrollStateChange}
              {...(actions.onRetryMessage ? { onRetry: actions.onRetryMessage } : {})}
            />
          ) : (
            <div className="grid h-full place-items-center">{emptyState}</div>
          )}

          {state.pendingDecision && (
            <div className="nova-decision-layer pointer-events-none absolute inset-0 z-20 flex flex-col justify-end">
              <DecisionPrompt
                request={state.pendingDecision}
                autoApproveInSeconds={state.approvalAutoConfirmInSeconds}
                disabled={state.isResolvingDecision}
                onResolve={actions.onResolveDecision}
                {...(actions.onAbort ? { onAbort: actions.onAbort } : {})}
                isAborting={state.isAborting}
              />
            </div>
          )}

          {errorFeedback.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex max-h-[min(45dvh,24rem)] flex-col justify-end gap-2 overflow-y-auto px-3 pb-2 sm:px-4">
              {errorFeedback.map((feedback) => (
                <div
                  key={feedback.id}
                  className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800 shadow-[0_18px_44px_-28px_rgb(136_19_55_/_0.5)] ring-1 ring-rose-200 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-100 dark:ring-rose-900"
                  role="alert"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 break-words">{feedback.message}</span>
                  {feedback.dismissible && actions.onDismissFeedback && (
                    <button
                      type="button"
                      className="shrink-0 font-semibold"
                      onClick={() => actions.onDismissFeedback?.(feedback.id)}
                    >
                      关闭
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          ref={composerDockRef}
          className="absolute inset-x-0 bottom-0 z-20 min-w-0 overflow-visible border-t border-slate-200/50  px-3 pb-0 pt-0 dark:border-slate-800/60 dark:bg-slate-950/30 sm:px-4 sm:pb-1.5"
        >
          <div className="nova-chat-content">
            {sidebarOpen && incompleteTodos > 0 && (
              <div className="mb-2 xl:hidden">
                <TodoPanel items={state.todos} collapsed />
              </div>
            )}

            {composerFeedback.map((feedback) => (
              <div
                key={feedback.id}
                className={`mb-2 flex items-start justify-between gap-3 rounded-xl px-3 py-2.5 text-sm ring-1 ${feedbackClasses[feedback.tone]}`}
                role="status"
              >
                <div className="min-w-0 flex-1">
                  <p>{feedback.message}</p>
                  {feedback.description && <p className="mt-1">{feedback.description}</p>}
                  {feedback.action && <div className="mt-2">{feedback.action}</div>}
                </div>
                {feedback.dismissible && actions.onDismissFeedback && (
                  <button
                    type="button"
                    className="shrink-0 font-semibold"
                    onClick={() => actions.onDismissFeedback?.(feedback.id)}
                  >
                    关闭
                  </button>
                )}
              </div>
            ))}

            {connectionMessage && (
              <div
                className="mb-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200"
                role="status"
              >
                {connectionMessage}
              </div>
            )}

            {state.queuedMessages.length > 0 && (
              <div className="relative z-0 mx-4 -mb-3 overflow-hidden rounded-t-2xl border border-b-0 border-slate-200 bg-white pb-3 shadow-sm sm:mx-5">
                <div className="nova-scrollbar max-h-44 overflow-x-hidden overflow-y-auto overscroll-contain">
                  {state.queuedMessages.map((message) => (
                    <div
                      key={message.id}
                      className="flex min-h-11 min-w-0 items-center gap-2 overflow-hidden border-b border-slate-100 px-3.5 text-sm last:border-b-0"
                    >
                      <CornerDownRight className="size-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-slate-800">{message.text}</span>
                      {state.isRunning && message.canSteer !== false && actions.onSteerQueuedMessage && (
                        <button
                          type="button"
                          disabled={state.isSteeringQueuedMessage}
                          onClick={() => void actions.onSteerQueuedMessage?.(message.id)}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-45"
                        >
                          <CornerDownLeft className="size-3" aria-hidden="true" />
                          {message.isSteering ? "正在调整" : "调整方向"}
                        </button>
                      )}
                      {actions.onRemoveQueuedMessage && (
                        <button
                          type="button"
                          aria-label="删除待处理消息"
                          disabled={state.isSteeringQueuedMessage}
                          onClick={() => actions.onRemoveQueuedMessage?.(message.id)}
                          className="grid size-7 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-45"
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="relative z-10">
              <Composer
                {...composer}
                isRunning={state.isRunning}
                isAborting={state.isAborting}
                {...(actions.onAbort ? { onAbort: actions.onAbort } : {})}
                onSubmit={actions.onSubmit}
              />
            </div>
          </div>
        </div>
      </div>

      {hasSidebar && (
        <aside className="nova-scrollbar hidden min-h-0 overflow-x-hidden overflow-y-auto border-l border-slate-200 p-3 xl:block">
          <div className="sticky top-3">
            {sidebar}
            {incompleteTodos > 0 && (
              <>
                <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">当前计划</p>
                <TodoPanel items={state.todos} />
              </>
            )}
          </div>
        </aside>
      )}

      {explorer && <RemoteExplorer {...explorer} />}
    </div>
  );
}
