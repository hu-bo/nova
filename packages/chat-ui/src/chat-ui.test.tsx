import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@nova/protocol";
import { BlockView, Composer, DecisionPrompt, MessageList, RemoteExplorer, TodoPanel, UploadCover } from "./index.js";

describe("chat-ui", () => {
  it("renders markdown and structured code", () => {
    const markdown = renderToStaticMarkup(<BlockView block={{ type: "text", text: "**完成**" }} />);
    const fencedCode = renderToStaticMarkup(<BlockView block={{ type: "text", text: "```text\n.\n└── src/\n```" }} />);
    const code = renderToStaticMarkup(
      <BlockView block={{ type: "code", language: "ts", code: "const done = true", path: "src/a.ts", startLine: 4 }} />,
    );
    expect(markdown).toContain("<strong>完成</strong>");
    expect(fencedCode).toContain("[&amp;_pre_code]:text-slate-200");
    expect(fencedCode).toContain('class="language-text"');
    expect(fencedCode).toContain(".\n└── src/");
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

  it("renders tool output as plain preformatted text instead of file controls", () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[
          {
            id: "message-1",
            conversationId: "conversation-1",
            role: "assistant",
            status: "done",
            createdAt: 1,
            blocks: [
              { type: "tool_call", callId: "call-1", name: "list_dir", args: { path: "." }, status: "ok" },
              {
                type: "tool_result",
                callId: "call-1",
                status: "ok",
                blocks: [{ type: "text", text: '{\n  "entries": ["build.rs", "src"]\n}' }],
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain('<pre class="m-0 max-h-80');
    expect(html).toContain("&quot;build.rs&quot;");
    expect(html).not.toContain("nova-file-block");
  });

  it("truncates long tool output in the preformatted view", () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[
          {
            id: "message-1",
            conversationId: "conversation-1",
            role: "assistant",
            status: "done",
            createdAt: 1,
            blocks: [
              { type: "tool_call", callId: "call-1", name: "bash", args: {}, status: "ok" },
              {
                type: "tool_result",
                callId: "call-1",
                status: "ok",
                blocks: [{ type: "text", text: `${"a".repeat(12_000)}END_ONLY` }],
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain("已省略 8 个字符");
    expect(html).not.toContain("END_ONLY");
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

  it("renders controlled host attachments without replacing the native file fallback", () => {
    const html = renderToStaticMarkup(
      <Composer
        attachments={[{ id: "remote-1", name: "runner.log", metadata: { path: "/tmp/runner.log" } }]}
        onAttachmentsChange={() => undefined}
        onAttachmentButtonClick={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain("runner.log");
    expect(html).toContain('aria-label="移除 runner.log"');
    expect(html).toContain('type="file"');
  });

  it("exposes upload interactions through the standalone cover", () => {
    const html = renderToStaticMarkup(
      <UploadCover files={[]} onFilesChange={() => undefined}>
        {({ trigger }) => <div>{trigger}</div>}
      </UploadCover>,
    );
    expect(html).toContain('type="file"');
    expect(html).toContain('aria-label="添加文件"');
  });

  it("exports the remote explorer dialog contract", () => {
    const html = renderToStaticMarkup(
      <RemoteExplorer
        open={false}
        mode="directory"
        onClose={() => undefined}
        loadDirectory={async () => ({ root: "/", path: "/", parent: null, entries: [] })}
        onConfirm={() => undefined}
      />,
    );
    expect(html).toBe("");
  });
});
