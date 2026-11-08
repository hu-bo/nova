
import {
  ArrowDown,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock3,
  Cpu,
  GitBranch,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { StrictMode, useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Composer, MessageList, type ChatMessage, type ComposerSubmission } from "../packages/chat-ui/src/index.js";
import "./styles.css";

type ProviderId = "openai" | "deepseek" | "custom";
type RunMode = "task" | "flow";
type PluginInfo = { id: string; scope: string; config: Record<string, string | number | boolean | null> };
type SessionInfo = { id: string; provider: string; model: string; plugins: PluginInfo[] };
type TraceEntry = {
  id: string;
  time: number;
  kind: "runtime" | "task" | "agent" | "model" | "tool" | "flow" | "error";
  title: string;
  detail?: string;
};

const traceIcons = {
  runtime: CircleCheck,
  task: TerminalSquare,
  agent: Bot,
  model: Cpu,
  tool: Wrench,
  flow: GitBranch,
  error: CircleAlert,
} satisfies Record<TraceEntry["kind"], typeof CircleCheck>;

const providers: Record<ProviderId, { label: string; baseURL: string; model: string }> = {
  openai: { label: "OpenAI", baseURL: "https://api.openai.com/v1", model: "" },
  deepseek: { label: "DeepSeek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  custom: { label: "OpenAI 兼容", baseURL: "", model: "" },
};

const starterPrompts = [
  { icon: Clock3, text: "现在的北京时间是多少？" },
  { icon: Wrench, text: "用工具计算 37 × 48，并说明结果。" },
  { icon: GitBranch, text: "解释一下这个演示里 Task 和 Flow 的区别。" },
];

function shortId(value: string): string {
  return value.slice(0, 8);
}

function updateMessage(messages: ChatMessage[], id: string, update: (message: ChatMessage) => ChatMessage) {
  return messages.map((message) => (message.id === id ? update(message) : message));
}

function Demo() {
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [baseURL, setBaseURL] = useState(providers.openai.baseURL);
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [session, setSession] = useState<SessionInfo>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [mode, setMode] = useState<RunMode>("task");
  const [connecting, setConnecting] = useState(false);
  const [running, setRunning] = useState(false);
  const [providerVerified, setProviderVerified] = useState(false);
  const [usage, setUsage] = useState<{ input: number | null; output: number | null }>();
  const [notice, setNotice] = useState("");
  const abortRef = useRef<AbortController | undefined>(undefined);
  const sessionRef = useRef<SessionInfo | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(
    () => () => {
      const activeSession = sessionRef.current;
      if (activeSession) {
        void fetch(`/api/sessions/${encodeURIComponent(activeSession.id)}`, { method: "DELETE", keepalive: true });
      }
    },
    [],
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, trace]);

  function addTrace(kind: TraceEntry["kind"], title: string, detail?: string) {
    setTrace((items) => [
      ...items.slice(-99),
      { id: crypto.randomUUID(), time: Date.now(), kind, title, ...(detail ? { detail } : {}) },
    ]);
  }

  async function deleteSession(id: string) {
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiKey.trim() || !modelName.trim() || !baseURL.trim()) {
      setNotice("请填写 API Key、模型 ID 和 Base URL。");
      return;
    }
    setConnecting(true);
    setNotice("");
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: providers[provider].label, baseURL, apiKey, model: modelName }),
      });
      const payload = (await response.json()) as SessionInfo & { error?: string };
      if (!response.ok) throw new Error(payload.error || "无法创建 Harness Runtime。");
      const previousSession = session?.id;
      setSession(payload);
      setApiKey("");
      setMessages([]);
      setTrace([
        {
          id: crypto.randomUUID(),
          time: Date.now(),
          kind: "runtime",
          title: "Kernel ready",
          detail: `session ${shortId(payload.id)}`,
        },
      ]);
      setProviderVerified(false);
      setUsage(undefined);
      setNotice("");
      if (previousSession) void deleteSession(previousSession);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Harness Runtime 创建失败。");
    } finally {
      setConnecting(false);
    }
  }

  function onProviderChange(value: ProviderId) {
    setProvider(value);
    if (value !== "custom") {
      setBaseURL(providers[value].baseURL);
      setModelName(providers[value].model);
    }
  }

  async function consumeRun(text: string, assistantId: string) {
    if (!session) return false;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setNotice("");
    setUsage(undefined);
    addTrace(mode === "flow" ? "flow" : "task", mode === "flow" ? "Flow submitted" : "Task submitted", mode);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, mode }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error || "请求未能进入 Harness。");
      }
      if (!response.body) throw new Error("当前浏览器不支持流式响应。");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;

      const handleEvent = (event: Record<string, unknown>) => {
        if (event.type === "task.event") {
          const task = event.event as { taskId?: string; status?: string; seq?: number };
          addTrace(
            "task",
            `Task · ${task.status ?? "updated"}`,
            task.taskId ? `${shortId(task.taskId)} · event ${task.seq ?? ""}` : undefined,
          );
        } else if (event.type === "agent.event") {
          const agent = event.event as {
            type?: string;
            runId?: string;
            sessionId?: string;
            text?: string;
            name?: string;
            status?: string;
          };
          if (agent.type === "assistant.delta" && agent.text) {
            setMessages((items) =>
              updateMessage(items, assistantId, (message) => {
                const blocks = [...message.blocks];
                const last = blocks[blocks.length - 1];
                if (last?.type === "text") blocks[blocks.length - 1] = { ...last, text: last.text + agent.text };
                else blocks.push({ type: "text", text: agent.text! });
                return { ...message, blocks };
              }),
            );
          } else if (agent.type === "run.started") {
            addTrace("agent", "Agent run started", `${agent.sessionId ?? "session"} · ${shortId(agent.runId ?? "")}`);
          } else if (agent.type === "tool.started") {
            addTrace("tool", `Tool · ${agent.name ?? "unknown"}`, "正在执行 Harness Tool Runtime");
          } else if (agent.type === "tool.finished") {
            addTrace("tool", `Tool ${agent.status === "succeeded" ? "completed" : "failed"}`, agent.name);
          } else if (agent.type === "run.finished") {
            addTrace("agent", `Agent run ${agent.status ?? "finished"}`);
          }
        } else if (event.type === "run.completed") {
          completed = true;
          const result = event.result as {
            status?: string;
            text?: string;
            usage?: { inputTokens?: number | null; outputTokens?: number | null };
            toolCalls?: Array<{
              name?: string;
              callId?: string;
              status?: string;
              value?: unknown;
              error?: { message?: string };
            }>;
            stages?: Array<{ id?: string; status?: string; text?: string }>;
          };
          setProviderVerified(result.status === "succeeded");
          setUsage({ input: result.usage?.inputTokens ?? null, output: result.usage?.outputTokens ?? null });
          addTrace(
            "model",
            result.status === "succeeded" ? "Provider response received" : `Run ${result.status ?? "finished"}`,
          );
          for (const stage of result.stages ?? [])
            addTrace("flow", `${stage.id ?? "node"} · ${stage.status ?? "done"}`, stage.text?.slice(0, 180));
          setMessages((items) =>
            updateMessage(items, assistantId, (message) => {
              const blocks = [...message.blocks];
              if (result.stages?.some((stage) => stage.id === "draft" && stage.text)) {
                const draft = result.stages.find((stage) => stage.id === "draft")?.text;
                if (draft) blocks.unshift({ type: "thinking", text: `Flow 草稿节点\n${draft}` });
              }
              const finalText = result.text ?? "";
              const firstText = blocks.findIndex((block) => block.type === "text");
              if (firstText >= 0)
                blocks[firstText] = {
                  type: "text",
                  text: finalText || (blocks[firstText]?.type === "text" ? blocks[firstText].text : ""),
                };
              else if (finalText) blocks.push({ type: "text", text: finalText });
              for (const tool of result.toolCalls ?? []) {
                const callId = tool.callId ?? crypto.randomUUID();
                const ok = tool.status === "succeeded";
                blocks.push({
                  type: "tool_call",
                  callId,
                  name: tool.name ?? "tool",
                  args: {},
                  status: ok ? "ok" : "error",
                });
                if (ok) {
                  blocks.push({
                    type: "tool_result",
                    callId,
                    status: "ok",
                    blocks: [{ type: "text", text: JSON.stringify(tool.value ?? null, null, 2) }],
                  });
                } else {
                  blocks.push({
                    type: "tool_result",
                    callId,
                    status: "error",
                    blocks: [{ type: "error", code: "TOOL_FAILED", message: tool.error?.message ?? "Tool 执行失败" }],
                  });
                }
              }
              return { ...message, blocks, status: result.status === "succeeded" ? "done" : "error" };
            }),
          );
        } else if (event.type === "run.failed") {
          completed = true;
          const failure = event.error as { code?: string; message?: string };
          addTrace("error", failure?.code ?? "RUN_FAILED", failure?.message);
          setMessages((items) =>
            updateMessage(items, assistantId, (message) => ({
              ...message,
              status: "error",
              blocks: [
                ...message.blocks,
                { type: "error", code: failure?.code ?? "RUN_FAILED", message: failure?.message ?? "Agent 运行失败。" },
              ],
            })),
          );
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame
            .split(/\r?\n/)
            .find((line) => line.startsWith("data:"))
            ?.slice(5)
            .trim();
          if (!data) continue;
          try {
            handleEvent(JSON.parse(data) as Record<string, unknown>);
          } catch {
            addTrace("error", "Invalid stream event");
          }
        }
      }
      if (!completed && !controller.signal.aborted) throw new Error("Harness 流在完成事件前结束。");
      return true;
    } catch (error) {
      if (controller.signal.aborted) {
        setMessages((items) => updateMessage(items, assistantId, (message) => ({ ...message, status: "aborted" })));
        addTrace("runtime", "Run cancelled by user");
      } else {
        const message = error instanceof Error ? error.message : "请求失败。";
        setNotice(message);
        setMessages((items) =>
          updateMessage(items, assistantId, (current) => ({
            ...current,
            status: "error",
            blocks: current.blocks.length ? current.blocks : [{ type: "error", code: "REQUEST_FAILED", message }],
          })),
        );
        addTrace("error", "Request failed", message);
      }
      return true;
    } finally {
      abortRef.current = undefined;
      setRunning(false);
    }
  }

  async function send(submission: ComposerSubmission) {
    if (!session) {
      setNotice("先在左侧配置供应商并创建 Harness Runtime。");
      return false;
    }
    if (submission.files.length || submission.attachments.length) {
      setNotice("这个 Harness 演示只处理文本，文件和图片能力可在业务宿主中接入。");
      return false;
    }
    const text = submission.text.trim();
    if (!text) return false;
    const messageId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const now = Date.now();
    setNotice("");
    setMessages((items) => [
      ...items,
      {
        id: messageId,
        conversationId: session.id,
        role: "user",
        status: "done",
        createdAt: now,
        blocks: [{ type: "text", text }],
      },
      {
        id: assistantId,
        conversationId: session.id,
        role: "assistant",
        status: "streaming",
        createdAt: now + 1,
        blocks: [],
      },
    ]);
    return consumeRun(text, assistantId);
  }

  async function resetConversation() {
    if (running) abortRef.current?.abort();
    if (session) await deleteSession(session.id);
    setSession(undefined);
    setMessages([]);
    setTrace([]);
    setProviderVerified(false);
    setUsage(undefined);
    setNotice("Runtime 已释放。再次连接会创建新的内存会话。");
  }

  return (
    <main className="lab-shell">
      <header className="lab-topbar">
        <a className="brand-lockup" href="#top" aria-label="Nova Harness Lab">
          <span className="brand-mark">
            <Sparkles size={18} strokeWidth={2.2} />
          </span>
          <span className="brand-copy">
            <strong>nova</strong>
            <span>HARNESS LAB</span>
          </span>
        </a>
        <div className="topbar-center">
          <span className="local-indicator" /> 本地 Runtime <span className="topbar-divider">/</span> 真实模型链路
        </div>
        <div className="topbar-actions">
          <span className={`connection-pill ${session ? "is-ready" : ""}`}>
            <span />
            {session ? "Harness 已就绪" : "尚未连接"}
          </span>
          {session && (
            <button type="button" className="icon-button" title="释放 Runtime" onClick={() => void resetConversation()}>
              <RotateCcw size={15} />
            </button>
          )}
        </div>
      </header>

      <section className="lab-heading" id="top">
        <div>
          <div className="eyebrow">
            <span>DEVELOPER PLAYGROUND</span>
            <span className="eyebrow-line" />
          </div>
          <h1>
            把 Harness 跑起来<span>.</span>
          </h1>
          <p>接入真实模型，沿着 Agent、Task、Tool 和 Flow 看见每一步。</p>
        </div>
        <div className="heading-note">
          <ShieldCheck size={17} />
          <span>
            API Key 仅在本次本地 Runtime 内存中使用
            <br />
            <small>刷新页面后需要重新配置</small>
          </span>
        </div>
      </section>

      <div className="workspace-grid">
        <aside className="setup-column">
          <section className="panel provider-panel">
            <div className="panel-heading">
              <span className="step-number">01</span>
              <div>
                <h2>模型连接</h2>
                <p>OpenAI Chat Completions 协议</p>
              </div>
              <span className={`panel-state ${session ? "active" : ""}`}>
                <span />
              </span>
            </div>
            <form onSubmit={(event) => void connect(event)} className="provider-form">
              <label className="field-label" htmlFor="provider">
                供应商
              </label>
              <div className="select-wrap">
                <Cpu size={15} />
                <select
                  id="provider"
                  value={provider}
                  onChange={(event) => onProviderChange(event.target.value as ProviderId)}
                >
                  <option value="openai">OpenAI</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="custom">自定义兼容端点</option>
                </select>
                <ChevronDown size={14} />
              </div>
              <label className="field-label" htmlFor="base-url">
                Base URL
              </label>
              <input
                id="base-url"
                value={baseURL}
                onChange={(event) => setBaseURL(event.target.value)}
                placeholder="https://api.example.com/v1"
                autoComplete="url"
                spellCheck={false}
              />
              <label className="field-label" htmlFor="model-id">
                模型 ID
              </label>
              <input
                id="model-id"
                value={modelName}
                onChange={(event) => setModelName(event.target.value)}
                placeholder="填写供应商支持的模型 ID"
                autoComplete="off"
                spellCheck={false}
              />
              <label className="field-label" htmlFor="api-key">
                API Key
              </label>
              <div className="secret-input">
                <KeyRound size={15} />
                <input
                  id="api-key"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={session ? "重建 Runtime 时填写" : "sk-…"}
                  autoComplete="new-password"
                />
                <span className="secret-tag">LOCAL</span>
              </div>
              <button className="connect-button" type="submit" disabled={connecting}>
                {connecting ? (
                  <LoaderCircle className="spin" size={16} />
                ) : session ? (
                  <RotateCcw size={16} />
                ) : (
                  <Zap size={16} />
                )}
                {connecting ? "正在创建 Runtime" : session ? "应用配置并重建" : "创建 Harness Runtime"}
                {!connecting && <ArrowRight size={15} />}
              </button>
              {notice && (
                <p className="notice">
                  <CircleAlert size={14} />
                  {notice}
                </p>
              )}
            </form>
            <div className="provider-footnote">
              <ShieldCheck size={14} />
              <span>密钥不会写入 localStorage 或磁盘。</span>
            </div>
          </section>

          <section className="panel pipeline-panel">
            <div className="panel-heading compact">
              <span className="step-number">02</span>
              <div>
                <h2>运行图</h2>
                <p>当前 Harness 插件</p>
              </div>
            </div>
            {session ? (
              <div className="plugin-list">
                {session.plugins.map((plugin, index) => (
                  <div className="plugin-row" key={plugin.id}>
                    <span className="plugin-index">{String(index + 1).padStart(2, "0")}</span>
                    <code>{plugin.id.replace("nnova.", "")}</code>
                    <span className={`scope-tag scope-${plugin.scope}`}>{plugin.scope}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="pipeline-placeholder">
                <span className="placeholder-node">
                  <Cpu size={15} /> model
                </span>
                <ArrowDown size={14} />
                <span className="placeholder-node">
                  <Bot size={15} /> agent + tools
                </span>
                <ArrowDown size={14} />
                <span className="placeholder-node">
                  <GitBranch size={15} /> task / flow
                </span>
              </div>
            )}
          </section>

          <div className="local-note">
            <ShieldCheck size={15} />
            <div>
              <strong>仅供本地开发</strong>
              <span>Harness 与供应商请求运行在当前开发进程中。</span>
            </div>
          </div>
        </aside>

        <section className="panel conversation-panel">
          <div className="conversation-header">
            <div className="conversation-title">
              <span className="conversation-icon">
                <MessageSquare size={17} />
              </span>
              <div>
                <h2>Conversation</h2>
                <p>{session ? `${session.provider} · ${session.model}` : "先创建 Runtime，再发送第一条消息"}</p>
              </div>
            </div>
            <div className="mode-switch" role="group" aria-label="Harness 运行模式">
              <button
                className={mode === "task" ? "selected" : ""}
                onClick={() => setMode("task")}
                type="button"
                disabled={running}
                title="通过 Task Engine 调度一次 Agent 执行"
              >
                <TerminalSquare size={14} />
                Task
              </button>
              <button
                className={mode === "flow" ? "selected" : ""}
                onClick={() => setMode("flow")}
                type="button"
                disabled={running}
                title="运行草稿到审阅的两节点 Flow"
              >
                <GitBranch size={14} />
                Flow <span className="flow-count">2</span>
              </button>
            </div>
          </div>

          <div className="nova-chat conversation-body" ref={scrollRef}>
            {messages.length ? (
              <MessageList messages={messages} />
            ) : (
              <div className="empty-state">
                <div className="empty-orbit">
                  <span className="orbit-center">
                    <Bot size={23} />
                  </span>
                  <i />
                  <i />
                  <i />
                </div>
                <span className="empty-kicker">MODEL → AGENT → TOOL → RESULT</span>
                <h3>{session ? "Runtime 已准备好" : "开始一次真实的 Harness 运行"}</h3>
                <p>
                  {session
                    ? "输入问题，观察模型流式输出、工具执行和任务状态。"
                    : "配置兼容供应商，Harness 会在本地创建会话和运行时。"}
                </p>
                {session && (
                  <div className="prompt-suggestions">
                    {starterPrompts.map(({ icon: Icon, text }) => (
                      <button key={text} type="button" onClick={() => void send({ text, files: [], attachments: [] })}>
                        <Icon size={14} />
                        <span>{text}</span>
                        <ArrowRight size={13} />
                      </button>
                    ))}
                  </div>
                )}
                {!session && (
                  <div className="empty-flow">
                    <span>
                      <KeyRound size={13} /> credentials
                    </span>
                    <ArrowRight size={13} />
                    <span>
                      <Cpu size={13} /> model route
                    </span>
                    <ArrowRight size={13} />
                    <span>
                      <Bot size={13} /> agent
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="composer-wrap">
            {running && (
              <div className="streaming-banner">
                <span className="stream-dot" />
                Harness 正在运行 <span>·</span> {mode === "flow" ? "draft → review" : "agent.send"}
                <button type="button" onClick={() => abortRef.current?.abort()}>
                  <X size={13} />
                  停止
                </button>
              </div>
            )}
            <Composer
              allowFiles={false}
              disabled={!session}
              isRunning={running}
              isAborting={false}
              onAbort={() => abortRef.current?.abort()}
              placeholder={session ? "向真实模型发送消息…" : "连接模型后即可开始"}
              onSubmit={send}
            />
            <div className="composer-caption">
              <span>
                <kbd>Enter</kbd> 发送 <kbd>Shift</kbd>
                <span>+</span>
                <kbd>Enter</kbd> 换行
              </span>
              <span>文本演示 · 文件由宿主业务接入</span>
            </div>
          </div>
        </section>

        <aside className="inspect-column">
          <section className="panel run-panel">
            <div className="inspect-heading">
              <div>
                <span className="inspect-kicker">OBSERVABILITY</span>
                <h2>运行观测</h2>
              </div>
              <span className={`live-badge ${running ? "live" : ""}`}>
                <span />
                {running ? "LIVE" : "READY"}
              </span>
            </div>
            <div className="metric-grid">
              <div className="metric">
                <span>输入 Tokens</span>
                <strong>{usage?.input ?? "—"}</strong>
              </div>
              <div className="metric">
                <span>输出 Tokens</span>
                <strong>{usage?.output ?? "—"}</strong>
              </div>
            </div>
            <div className="provider-result">
              <span className={`result-icon ${providerVerified ? "success" : "pending"}`}>
                {providerVerified ? <Check size={13} /> : <Cpu size={13} />}
              </span>
              <div>
                <strong>{providerVerified ? "Provider 请求成功" : "等待模型请求"}</strong>
                <span>{session ? `${session.provider} · ${session.model}` : "尚未建立模型路由"}</span>
              </div>
            </div>
            <div className="trace-heading">
              <span>EXECUTION TRACE</span>
              <span>{trace.length.toString().padStart(2, "0")}</span>
            </div>
            <div className="trace-list">
              {trace.length ? (
                trace
                  .slice()
                  .reverse()
                  .map((item) => {
                    const Icon = traceIcons[item.kind];
                    return (
                      <div className={`trace-entry trace-${item.kind}`} key={item.id}>
                        <span className="trace-icon">
                          <Icon size={13} />
                        </span>
                        <div className="trace-copy">
                          <strong>{item.title}</strong>
                          {item.detail && <span>{item.detail}</span>}
                        </div>
                        <time>
                          {new Date(item.time).toLocaleTimeString("zh-CN", {
                            hour12: false,
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </time>
                      </div>
                    );
                  })
              ) : (
                <div className="trace-empty">
                  <span className="trace-empty-icon">
                    <Zap size={15} />
                  </span>
                  <p>运行事件会显示在这里</p>
                  <span>Task 状态 · Agent 事件 · Tool 调用</span>
                </div>
              )}
            </div>
          </section>

          <section className="panel harness-panel">
            <div className="panel-heading compact">
              <span className="harness-icon">
                <Sparkles size={14} />
              </span>
              <div>
                <h2>本次覆盖</h2>
                <p>{mode === "flow" ? "两节点 Flow 执行链路" : "单次 Agent Task 链路"}</p>
              </div>
            </div>
            <div className="coverage-list">
              {(mode === "flow"
                ? ["Task Queue", "Flow: draft", "input binding", "Flow: review", "Task Result"]
                : ["Task Queue", "Agent Session", "Model Stream", "Tool Runtime", "Task Result"]
              ).map((item, index) => (
                <div key={item} className="coverage-row">
                  <span className={`coverage-dot ${session && (providerVerified || index < 2) ? "done" : ""}`} />
                  {item}
                  {index < (mode === "flow" ? 4 : 4) && <span className="coverage-line" />}
                </div>
              ))}
            </div>
            <div className="coverage-foot">
              <CircleCheck size={14} />
              <span>数据只保存在当前进程内存</span>
            </div>
          </section>
        </aside>
      </div>
      <footer className="lab-footer">
        <span>
          <span className="footer-mark" /> NOVA HARNESS LAB
        </span>
        <span>本地进程 · 内存存储 · OpenAI 兼容模型适配</span>
        <span>4175</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
