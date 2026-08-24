import type { ChatMessage, DecisionResponse, Todo } from "@nova/protocol";
import { Composer, DecisionPrompt, MessageList, TodoPanel, type ComposerSubmission } from "../src/index.js";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const initialMessages: ChatMessage[] = [
  {
    id: "user-1",
    conversationId: "demo",
    role: "user",
    status: "done",
    createdAt: Date.now() - 4_000,
    blocks: [{ type: "text", text: "请检查登录流程并给出修改方案。" }],
  },
  {
    id: "assistant-1",
    conversationId: "demo",
    role: "assistant",
    status: "done",
    createdAt: Date.now() - 3_000,
    blocks: [
      { type: "thinking", text: "先定位认证边界，再检查 token 刷新与错误状态。" },
      { type: "tool_call", callId: "read-1", name: "read_file", args: { path: "src/auth/provider.tsx" }, status: "ok" },
      {
        type: "tool_result",
        callId: "read-1",
        status: "ok",
        blocks: [
          {
            type: "code",
            language: "tsx",
            path: "src/auth/provider.tsx",
            startLine: 18,
            code: "const api = useMemo(() => token ? createClient(token) : null, [token]);",
          },
        ],
      },
      {
        type: "diff",
        path: "src/auth/provider.tsx",
        added: 3,
        removed: 1,
        diff: "@@ -18,1 +18,3 @@\n-const api = createClient(token)\n+const api = useMemo(\n+  () => token ? createClient(token) : null,\n+  [token],\n+)",
      },
      { type: "text", text: "已把客户端生命周期绑定到 token，下一步需要验证登出后的缓存清理。" },
    ],
  },
];

const todos: Todo[] = [
  { id: "1", text: "检查认证状态所有权", status: "completed" },
  { id: "2", text: "模拟工具调用与代码块", status: "in_progress" },
  { id: "3", text: "验证审批和反问交互", status: "pending" },
];

function Demo() {
  const [messages, setMessages] = useState(initialMessages);
  const [resolved, setResolved] = useState<DecisionResponse>();
  const [model, setModel] = useState("gpt-5");
  const [reasoning, setReasoning] = useState("medium");

  function send(submission: ComposerSubmission) {
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      conversationId: "demo",
      role: "user",
      status: "done",
      createdAt: Date.now(),
      blocks: [{ type: "text", text: submission.text || `发送了 ${submission.files.length} 个附件` }],
    };
    setMessages((current) => [...current, user]);
    setTimeout(() => {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          conversationId: "demo",
          role: "assistant",
          status: "done",
          createdAt: Date.now(),
          blocks: [
            {
              type: "text",
              text: `Mock 回复：已收到消息。模型 ${submission.model}，推理强度 ${submission.reasoningEffort}。`,
            },
          ],
        },
      ]);
    }, 500);
  }

  return (
    <main className="demo-shell">
      <header className="demo-header">
        <div>
          <span>COMPONENT PLAYGROUND</span>
          <h1>@nova/chat-ui</h1>
          <p>全部数据由本地代码 mock，可直接调试消息、工具、审批、TODO 与 Composer 交互。</p>
        </div>
        <div className="demo-status">DEV · 4175</div>
      </header>
      <div className="demo-grid">
        <section className="demo-chat">
          <div className="demo-section-title">
            <div>
              <h2>Conversation</h2>
              <p>{messages.length} 条 mock 消息</p>
            </div>
            <button type="button" onClick={() => setMessages(initialMessages)}>
              重置
            </button>
          </div>
          <div className="demo-messages">
            <MessageList
              messages={messages}
              onRetry={(id) => alert(`Retry ${id}`)}
              onOpenPath={(path, line) => alert(`${path}:${line ?? 1}`)}
            />
          </div>
          <Composer
            models={[
              { value: "gpt-5", label: "GPT-5" },
              { value: "claude-sonnet", label: "Claude Sonnet" },
            ]}
            model={model}
            onModelChange={setModel}
            reasoningEfforts={[
              { value: "low", label: "低" },
              { value: "medium", label: "中" },
              { value: "high", label: "高" },
            ]}
            reasoningEffort={reasoning}
            onReasoningEffortChange={setReasoning}
            accept="image/*,.md,.txt"
            onSubmit={send}
          />
        </section>
        <aside className="demo-side">
          <section>
            <h2>Decision</h2>
            <DecisionPrompt
              request={{
                kind: "approval",
                decisionId: "demo-approval",
                toolName: "exec",
                args: { command: "pnpm typecheck" },
                risk: "exec",
              }}
              resolved={resolved}
              onResolve={(response) => setResolved(response)}
            />
            {resolved && (
              <button type="button" className="demo-reset" onClick={() => setResolved(undefined)}>
                重新演示
              </button>
            )}
          </section>
          <section>
            <h2>Plan</h2>
            <TodoPanel items={todos} />
          </section>
          <section>
            <h2>Question</h2>
            <DecisionPrompt
              request={{
                kind: "question",
                decisionId: "demo-question",
                question: "下一步重点调试哪些状态？",
                options: ["Loading", "Error", "Streaming"],
                multiSelect: true,
              }}
              onResolve={(response) => alert(JSON.stringify(response))}
            />
          </section>
        </aside>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
