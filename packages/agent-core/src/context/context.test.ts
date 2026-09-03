// testing.md §2：agent-core/context 与 session 树的可单测部分。
// 不启动任何进程：entry() 工厂 + 脚本化 StreamFn。
import { describe, expect, it } from "vitest";
import { createTokenEstimator, type ModelEvent, type StreamFn } from "@nova/model-adapters";
import type { Message, Todo } from "../types.js";
import { entry, type Entry } from "../session/entry.js";
import { branchView, toContextMessages, toMessages } from "../session/tree.js";
import { COMPACT_THRESHOLD, maxInputTokens, shouldCompact } from "./budget.js";
import { planCompaction } from "./compaction.js";
import { TODO_ENFORCE, TODO_SUGGEST, renderTodoInjection, unfinishedCount } from "./todo.js";

function message(role: "user" | "assistant", blocks: Message["blocks"]): Message {
  return { id: `msg-${Math.random().toString(36).slice(2)}`, role, blocks, createdAt: Date.now() };
}
function userEntry(text: string): Entry {
  return entry({ kind: "message", message: message("user", [{ type: "text", text }]) });
}
function assistantEntry(text: string): Entry {
  return entry({ kind: "message", message: message("assistant", [{ type: "text", text }]) });
}
function toolCallEntry(callId: string): Entry {
  return entry({
    kind: "message",
    message: message("assistant", [{ type: "tool_call", callId, name: "t", args: {} }]),
  });
}
function toolResultEntry(callId: string): Entry {
  return entry({
    kind: "message",
    message: message("user", [{ type: "tool_result", callId, status: "ok", content: [{ type: "text", text: "r" }] }]),
  });
}

const testEstimator = createTokenEstimator({ provider: "gateway", model: "test" });

describe("shouldCompact", () => {
  it(`input 达到 maxInputTokens * ${COMPACT_THRESHOLD} 触发`, () => {
    expect(shouldCompact(850, 1000)).toBe(true);
    expect(shouldCompact(849, 1000)).toBe(false);
    expect(shouldCompact(9999, 0)).toBe(false);
    expect(maxInputTokens({ provider: "gateway", model: "m", contextWindow: 10_000, maxOutput: 2_000 })).toBe(6_976);
  });
});

describe("planCompaction", () => {
  function summarizerStream(results: Array<"error" | string>): { stream: StreamFn; calls: number } {
    const state = { calls: 0 };
    const stream: StreamFn = async function* () {
      const outcome = results[state.calls] ?? "error";
      state.calls += 1;
      if (outcome === "error") {
        yield { type: "finish", stopReason: "error", errorMessage: "provider down" } satisfies ModelEvent;
        return;
      }
      yield { type: "block.end", index: 0, block: { type: "text", text: outcome } } satisfies ModelEvent;
      yield { type: "finish", stopReason: "stop" } satisfies ModelEvent;
    };
    return {
      stream,
      get calls() {
        return state.calls;
      },
    };
  }

  const entries = () => [
    userEntry("goal"),
    assistantEntry("work"),
    userEntry("middle"),
    assistantEntry("details"),
    userEntry("next step"),
    assistantEntry("more"),
  ];
  const estimator = createTokenEstimator({ provider: "gateway", model: "test" });
  const deps = (stream: StreamFn) => ({
    stream,
    signal: new AbortController().signal,
    estimator,
    maxInputTokens: 10_000,
  });

  it("摘要成功：cut point 之前的前缀被摘要替换", async () => {
    const { stream } = summarizerStream(["THE-SUMMARY"]);
    const list = entries();
    const plan = await planCompaction(list, deps(stream));
    expect(plan).not.toBeNull();
    expect(plan!.summary).toBe("THE-SUMMARY");
    expect(plan!.summarized).toBe(true);
    expect(plan!.startIndex).toBe(2);
    expect(plan!.endIndex).toBe(4);
    expect(plan!.replacedFrom).toBe(list[2]!.id);
    expect(plan!.replacedTo).toBe(list[3]!.id);
  });

  it("摘要失败重试 2 次后成功（共 3 次尝试）", async () => {
    const fake = summarizerStream(["error", "error", "LATE-SUMMARY"]);
    const plan = await planCompaction(entries(), deps(fake.stream));
    expect(fake.calls).toBe(3);
    expect(plan!.summary).toBe("LATE-SUMMARY");
    expect(plan!.summarized).toBe(true);
  });

  it("摘要始终失败 → 省略中段完整 turn", async () => {
    const fake = summarizerStream(["error", "error", "error"]);
    const plan = await planCompaction(entries(), deps(fake.stream));
    expect(fake.calls).toBe(3);
    expect(plan!.summarized).toBe(false);
    expect(plan!.summary).toContain("中间 1 个 turn");
    expect(plan!.startIndex).toBe(2);
  });

  it("摘要 context overflow 不重复相同请求，直接省略中段", async () => {
    let calls = 0;
    const stream: StreamFn = async function* (request) {
      calls += 1;
      expect(request.maxOutput).toBe(2_048);
      yield { type: "finish", stopReason: "error", errorCode: "context_overflow" };
    };
    const plan = await planCompaction(entries(), deps(stream));
    expect(calls).toBe(1);
    expect(plan?.summarized).toBe(false);
    expect(plan?.summary).toContain("原始记录仍保留");
  });

  it("中段 tool call、result 与最终回答作为完整 turn 一起替换", async () => {
    const fake = summarizerStream(["TOOL-SUMMARY"]);
    const list = [
      userEntry("goal"),
      assistantEntry("start"),
      userEntry("inspect"),
      toolCallEntry("call-1"),
      toolResultEntry("call-1"),
      assistantEntry("observed"),
      userEntry("latest"),
      assistantEntry("continue"),
    ];
    const plan = await planCompaction(list, deps(fake.stream));
    expect(plan).toMatchObject({ startIndex: 2, endIndex: 6, summarized: true });
    expect(list.slice(plan!.startIndex, plan!.endIndex)).toEqual(list.slice(2, 6));
  });

  it("未完成的单 turn → null", async () => {
    const { stream } = summarizerStream(["S"]);
    const plan = await planCompaction([userEntry("only")], deps(stream));
    expect(plan).toBeNull();
  });
});

describe("branchView / toMessages", () => {
  it("compaction 标记折叠被替换的前缀，后续压缩可链式折叠", () => {
    const m0 = userEntry("a");
    const m1 = assistantEntry("b");
    const m2 = userEntry("c");
    const m3 = assistantEntry("d");
    const c1 = entry({ kind: "compaction", summary: "S1", replacedFrom: m0.id, replacedTo: m1.id });
    const c2 = entry({ kind: "compaction", summary: "S2", replacedFrom: c1.id, replacedTo: m2.id });
    const view = branchView([m0, m1, m2, m3, c1, c2]);
    expect(view.map((item) => item.id)).toEqual([c2.id, m3.id]);
  });

  it("toMessages：message → 消息；compaction → 摘要 user 消息；配置类 Entry 不进上下文", () => {
    const m0 = userEntry("hello");
    const c = entry({ kind: "compaction", summary: "S", replacedFrom: "x", replacedTo: "y" });
    const model = entry({ kind: "model", model: "m2" });
    const messages = toMessages([c, m0, model]);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.blocks[0]).toEqual({ type: "text", text: "[以下是早前对话的摘要]\nS" });
    expect(messages[1]!.role).toBe("user");
  });

  it("请求投影省略已完成旧 turn 的 thinking，但保留当前 tool turn 的 thinking", () => {
    const oldThinking = entry({
      kind: "message",
      message: message("assistant", [
        { type: "thinking", text: "old reasoning" },
        { type: "text", text: "done" },
      ]),
    });
    const currentThinking = entry({
      kind: "message",
      message: message("assistant", [
        { type: "thinking", text: "current reasoning" },
        { type: "tool_call", callId: "call-1", name: "read", args: {} },
      ]),
    });
    const projected = toContextMessages(
      [userEntry("first"), oldThinking, userEntry("second"), currentThinking, toolResultEntry("call-1")],
      testEstimator,
    );
    expect(
      projected
        .flatMap((item) => item.blocks)
        .some((block) => block.type === "thinking" && block.text === "old reasoning"),
    ).toBe(false);
    expect(
      projected
        .flatMap((item) => item.blocks)
        .some((block) => block.type === "thinking" && block.text === "current reasoning"),
    ).toBe(true);
  });

  it("工具结果仅在请求投影保留头尾，Entry 原文不变", () => {
    const original = `HEAD-${"x".repeat(20_000)}-TAIL`;
    const toolResult = entry({
      kind: "message",
      message: message("user", [
        { type: "tool_result", callId: "call-1", status: "ok", content: [{ type: "text", text: original }] },
      ]),
    });
    const projected = toContextMessages([toolCallEntry("call-1"), toolResult], testEstimator, 100);
    const block = projected[1]!.blocks[0]!;
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result" && block.content[0]?.type === "text") {
      expect(block.content[0].text).toContain("HEAD-");
      expect(block.content[0].text).toContain("-TAIL");
      expect(block.content[0].text).toContain("中段已省略");
    }
    expect(toolResult.kind).toBe("message");
    if (toolResult.kind === "message") {
      const stored = toolResult.message.blocks[0] as Extract<Message["blocks"][number], { type: "tool_result" }>;
      expect(stored.content[0]).toEqual({ type: "text", text: original });
    }
  });
});

describe("renderTodoInjection", () => {
  const items = (count: number, done = 0): Todo[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `todo-${i}`,
      text: `item ${i}`,
      status: i < done ? ("completed" as const) : i === done ? ("in_progress" as const) : ("pending" as const),
    }));

  it("低于阈值不注入（省 token）", () => {
    expect(renderTodoInjection(null)).toBeNull();
    expect(renderTodoInjection({ items: items(1), updatedAt: 0 })).toBeNull();
    expect(unfinishedCount({ items: items(1), updatedAt: 0 })).toBe(1);
  });

  it(`≥ ${TODO_SUGGEST} 未完成：一句话提醒`, () => {
    const text = renderTodoInjection({ items: items(2), updatedAt: 0 });
    expect(text).toContain("2 项未完成");
  });

  it(`≥ ${TODO_ENFORCE} 未完成：markdown 清单全列未完成项，completed 只计数`, () => {
    const list = items(4, 1);
    list[3] = { id: "todo-3", text: "waiting proto", status: "blocked", note: "等 proto 定稿" };
    const text = renderTodoInjection({ items: list, updatedAt: 0 })!;
    expect(text).toContain("已完成 1 项");
    expect(text).toContain("- [~] item 1");
    expect(text).toContain("- [ ] item 2");
    expect(text).toContain("- [!] waiting proto —— 阻塞：等 proto 定稿");
    expect(text).not.toContain("item 0");
  });
});
