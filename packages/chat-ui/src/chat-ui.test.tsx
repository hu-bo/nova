import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@nova/protocol";
import { BlockView, Composer, DecisionPrompt, MessageList, TodoPanel } from "./index.js";

describe("chat-ui", () => {
  it("renders markdown and structured code", () => {
    const markdown = renderToStaticMarkup(<BlockView block={{ type: "text", text: "**完成**" }} />);
    const code = renderToStaticMarkup(
      <BlockView block={{ type: "code", language: "ts", code: "const done = true", path: "src/a.ts", startLine: 4 }} />,
    );
    expect(markdown).toContain("<strong>完成</strong>");
    expect(code).toContain("src/a.ts:4");
    expect(code).toContain("const");
  });

  it("pairs tool calls and results while hiding todo_write", () => {
    const messages: ChatMessage[] = [
      {
        id: "message-1",
        conversationId: "conversation-1",
        role: "assistant",
        status: "done",
        createdAt: 1,
        blocks: [
          { type: "tool_call", callId: "call-1", name: "read_file", args: { path: "a.ts" }, status: "ok" },
          { type: "tool_result", callId: "call-1", status: "ok", blocks: [{ type: "text", text: "content" }] },
          { type: "tool_call", callId: "call-2", name: "todo_write", args: {}, status: "ok" },
          {
            type: "tool_result",
            callId: "call-2",
            status: "ok",
            blocks: [{ type: "todo", items: [{ id: "1", text: "ship", status: "pending" }] }],
          },
        ],
      },
    ];
    const html = renderToStaticMarkup(<MessageList messages={messages} />);
    expect(html.match(/read_file/g)).toHaveLength(1);
    expect(html).not.toContain("todo_write");
    expect(html).toContain("ship");
  });

  it("renders accessible decisions and read-only todos", () => {
    const decision = renderToStaticMarkup(
      <DecisionPrompt
        request={{
          kind: "approval",
          decisionId: "d1",
          toolName: "bash",
          args: { command: "rm build/output" },
          risk: "exec",
        }}
        onResolve={() => undefined}
      />,
    );
    const todo = renderToStaticMarkup(<TodoPanel items={[{ id: "1", text: "verify", status: "in_progress" }]} />);
    expect(decision).toContain("rm build/output");
    expect(decision).toContain("需要确认");
    expect(decision).toContain('data-slot="card"');
    expect(decision).toContain('data-slot="badge"');
    expect(todo).not.toContain("checkbox");
    expect(todo).toContain("verify");
    expect(todo).toContain('data-slot="card"');
  });

  it("supports instance renderer overrides", () => {
    const html = renderToStaticMarkup(
      <BlockView
        block={{ type: "text", text: "raw" }}
        renderers={{ text: ({ block }) => <mark>{block.type}</mark> }}
      />,
    );
    expect(html).toContain("<mark>text</mark>");
    expect(html).not.toContain("raw");
  });

  it("renders file, model, and reasoning controls in the composer", () => {
    const html = renderToStaticMarkup(
      <Composer
        models={[{ value: "gpt-5", label: "GPT-5" }]}
        model="gpt-5"
        onModelChange={() => undefined}
        reasoningEfforts={[
          { value: "low", label: "低" },
          { value: "high", label: "高" },
        ]}
        reasoningEffort="high"
        onReasoningEffortChange={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain('type="file"');
    expect(html).toContain("multiple");
    expect(html).toContain("粘贴截图");
    expect(html).toContain("GPT-5");
    expect(html).toContain("推理强度");
    expect(html).toContain('data-slot="textarea"');
    expect(html).toContain('data-slot="button"');
    expect(html).not.toContain("<select");
  });

  it("replaces the send button with an abort action while a run is active", () => {
    const html = renderToStaticMarkup(<Composer isRunning onAbort={() => undefined} onSubmit={() => undefined} />);
    expect(html).toContain('aria-label="中断当前运行"');
    expect(html).not.toContain('aria-label="发送消息"');
  });
});
