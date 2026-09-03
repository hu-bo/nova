import { CornerDownLeft, CornerDownRight, Trash2 } from "lucide-react";
import type { ChatMessage, DecisionRequest, DecisionResponse, Todo } from "@nova/protocol";
import { useEffect, type ReactNode } from "react";
import { Composer } from "./composer.js";
import type { ComposerProps, ComposerSubmission } from "./composer-types.js";
import { DecisionPrompt } from "./decision-prompt.js";
import { MessageList } from "./message-list.js";
import { RemoteExplorer, type RemoteExplorerProps } from "./remote-explorer.js";
import { TodoPanel } from "./todo-panel.js";

export interface ChatQueuedMessage {
  id: string;
  text: string;
  isSteering?: boolean | undefined;
}

export interface ChatFeedback {
  id: string;
  message: string;
  tone: "error" | "warning" | "info";
  dismissible?: boolean | undefined;
}

export interface ChatState {
  messages: ChatMessage[];
  todos: Todo[];
  queuedMessages: ChatQueuedMessage[];
  pendingDecision?: DecisionRequest | null | undefined;
  connection: "connecting" | "open" | "reconnecting" | "closed";
  isRunning: boolean;
  isAborting?: boolean | undefined;
  isResolvingDecision?: boolean | undefined;
  isSteeringQueuedMessage?: boolean | undefined;
  feedback?: ChatFeedback[] | undefined;
}

export type ChatComposerConfig<TMetadata = unknown> = Omit<
  ComposerProps<TMetadata>,
  "isRunning" | "isAborting" | "onAbort" | "onSubmit"
>;

export interface ChatActions<TMetadata = unknown> {
  onSubmit: (submission: ComposerSubmission<TMetadata>) => void | boolean | Promise<void | boolean>;
  onAbort?: (() => void | Promise<void>) | undefined;
  onRetryMessage?: ((messageId: string) => void) | undefined;
  onResolveDecision: (response: DecisionResponse) => void | Promise<void>;
  onRemoveQueuedMessage?: ((messageId: string) => void) | undefined;
  onSteerQueuedMessage?: ((messageId: string) => void | Promise<void>) | undefined;
  onDismissFeedback?: ((id: string) => void) | undefined;
}

export interface ChatProps<TMetadata = unknown> {
  state: ChatState;
  composer: ChatComposerConfig<TMetadata>;
  actions: ChatActions<TMetadata>;
  emptyState?: ReactNode | undefined;
  explorer?: RemoteExplorerProps | undefined;
}

const feedbackClasses: Record<ChatFeedback["tone"], string> = {
  error: "bg-rose-50 text-rose-700 ring-rose-200",
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
  info: "bg-indigo-50 text-indigo-800 ring-indigo-200",
};

export function Chat<TMetadata = unknown>({ state, composer, actions, emptyState, explorer }: ChatProps<TMetadata>) {
  const incompleteTodos = state.todos.filter((todo) => todo.status !== "completed").length;
  const connectionMessage =
    state.connection === "connecting"
      ? "正在连接实时消息流"
      : state.connection === "reconnecting"
        ? "实时消息流已断开，正在重连"
        : null;

  const onAbort = actions.onAbort;

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
      className={`nova-chat nova-chat-view grid min-h-0 flex-1 overflow-hidden bg-white ${incompleteTodos ? "xl:grid-cols-[minmax(0,1fr)_280px]" : ""}`}
    >
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-white">
        <div className="relative min-h-0 flex-1 overflow-hidden px-1 py-1 sm:px-0">
          {state.messages.length ? (
            <MessageList
              messages={state.messages}
              {...(actions.onRetryMessage ? { onRetry: actions.onRetryMessage } : {})}
            />
          ) : (
            <div className="grid h-full place-items-center">{emptyState}</div>
          )}
        </div>

        <div className="min-w-0 shrink-0 overflow-visible border-slate-200 bg-white px-3 pb-0 pt-1 sm:px-4 sm:pb-1.5">
          <div className="nova-chat-content">
            {incompleteTodos > 0 && (
              <div className="mb-2 xl:hidden">
                <TodoPanel items={state.todos} collapsed />
              </div>
            )}

            {state.feedback?.map((feedback) => (
              <div
                key={feedback.id}
                className={`mb-2 flex items-start justify-between gap-3 rounded-xl px-3 py-2.5 text-sm ring-1 ${feedbackClasses[feedback.tone]}`}
                role={feedback.tone === "error" ? "alert" : "status"}
              >
                <span>{feedback.message}</span>
                {feedback.dismissible && actions.onDismissFeedback && (
                  <button
                    type="button"
                    className="font-semibold"
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

            {state.pendingDecision && (
              <div className="mb-2">
                <DecisionPrompt
                  request={state.pendingDecision}
                  disabled={state.isResolvingDecision}
                  onResolve={actions.onResolveDecision}
                  {...(actions.onAbort ? { onAbort: actions.onAbort } : {})}
                  isAborting={state.isAborting}
                />
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
                      {actions.onSteerQueuedMessage && (
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

      {incompleteTodos > 0 && (
        <aside className="nova-scrollbar hidden min-h-0 overflow-x-hidden overflow-y-auto border-l border-slate-200 bg-white p-3 xl:block">
          <div className="sticky top-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">当前计划</p>
            <TodoPanel items={state.todos} />
          </div>
        </aside>
      )}

      {explorer && <RemoteExplorer {...explorer} />}
    </div>
  );
}
