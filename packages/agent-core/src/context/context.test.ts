// testing.md §2：agent-core/context 与 session 树的可单测部分。
// 不启动任何进程：entry() 工厂 + 脚本化 StreamFn。
import { describe, expect, it } from "vitest";
import type { ModelEvent, StreamFn } from "@nova/model-adapters";
import type { Message, Todo } from "../types.js";
import { entry, type Entry } from "../session/entry.js";
import { branchView, toMessages } from "../session/tree.js";
import { truncateContent, DEFAULT_CONTENT_LIMIT } from "./truncate.js";
import { COMPACT_THRESHOLD, shouldCompact } from "./budget.js";
import { findCutPoint, planCompaction } from "./compaction.js";
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
  return entry({ kind: "message", message: message("assistant", [{ type: "tool_call", callId, name: "t", args: {} }]) });
}
function toolResultEntry(callId: string): Entry {
  return entry({ kind: "message", message: message("user", [{ type: "tool_result", callId, status: "ok", content: [{ type: "text", text: "r" }] }]) });
}

describe("truncateContent", () => {
  it("短内容原样保留", () => {
    const parts = truncateContent([{ type: "text", text: "short" }]);
    expect(parts).toEqual([{ type: "text", text: "short" }]);
  });

  it("超长内容保头尾、中间省略并标注行数", () => {
    const lines = Array.from({ length: 6000 }, (_, i) => `line-${i}`);
    const parts = truncateContent([{ type: "text", text: lines.join("\n") }]);
    const joined = parts.map(part => (part.type === "text" ? part.text : "")).join("");
    expect(joined.startsWith("line-0\n")).toBe(true);
    expect(joined.endsWith("\nline-5999")).toBe(true);
    expect(joined).toMatch(/中间省略 \d+ 行/);
    expect(joined.length).toBeLessThan(DEFAULT_CONTENT_LIMIT + 100);
  });

  it("非文本 part 不参与截断", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "AAA" };
    const long = "x".repeat(DEFAULT_CONTENT_LIMIT + 5000);
    const parts = truncateContent([{ type: "text", text: long }, image]);
    expect(parts.some(part => part.type === "image")).toBe(true);
  });
});

describe("shouldCompact", () => {
  it(`input 超过 contextWindow * ${COMPACT_THRESHOLD} 才触发`, () => {
    expect(shouldCompact({ input: 801, output: 0 }, 1000)).toBe(true);
    expect(shouldCompact({ input: 800, output: 0 }, 1000)).toBe(false);
    expect(shouldCompact(null, 1000)).toBe(false);
    expect(shouldCompact({ input: 9999, output: 0 }, 0)).toBe(false);
  });
});

describe("findCutPoint（不得切开 tool_call 与 tool_result）", () => {
  it("优先切在最后一条干净 user message（新 turn 起点）", () => {
    const entries = [userEntry("a"), assistantEntry("b"), userEntry("c")];
    expect(findCutPoint(entries)).toBe(2);
  });

  it("只有 tool_result 边界时切在其后（assistant 回合已闭环）", () => {
    const entries = [userEntry("a"), toolCallEntry("c1"), toolResultEntry("c1"), assistantEntry("b")];
    expect(findCutPoint(entries)).toBe(3);
  });

  it("tool_result 是最后一条且后面没有内容 → 无处可切", () => {
    expect(findCutPoint([userEntry("a"), toolCallEntry("c1"), toolResultEntry("c1")])).toBeNull();
  });

  it("单 turn 进行中 → 无处可切", () => {
    expect(findCutPoint([userEntry("a"), assistantEntry("b")])).toBeNull();
  });

  it("切点之前的 tool_call 一定带着自己的 tool_result（或都不在保留段）", () => {
    const entries = [userEntry("a"), toolCallEntry("c1"), toolResultEntry("c1"), toolCallEntry("c2"), toolResultEntry("c2")];
    const cut = findCutPoint(entries);
    // c2 的 result 是最后一条 → 只能切在 c1 的 result 之后
    expect(cut).toBe(3);
    const kept = entries.slice(cut!);
    for (const item of kept) {
      if (item.kind === "message" && item.message.role === "user") {
        for (const block of item.message.blocks) {
          if (block.type !== "tool_result") continue;
          // 对应 tool_call 必须也在保留段里
          const hasCall = kept.some(other => other.kind === "message" && other.message.blocks.some(b => b.type === "tool_call" && b.callId === block.callId));
          expect(hasCall).toBe(true);
        }
      }
    }
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
    return { stream, get calls() { return state.calls; } };
  }

  const entries = () => [userEntry("goal"), assistantEntry("work"), userEntry("next step"), assistantEntry("more")];

  it("摘要成功：cut point 之前的前缀被摘要替换", async () => {
    const { stream } = summarizerStream(["THE-SUMMARY"]);
    const list = entries();
    const plan = await planCompaction(list, { stream, signal: new AbortController().signal });
    expect(plan).not.toBeNull();
    expect(plan!.summary).toBe("THE-SUMMARY");
    expect(plan!.summarized).toBe(true);
    expect(plan!.cutIndex).toBe(2);
    expect(plan!.replacedFrom).toBe(list[0]!.id);
    expect(plan!.replacedTo).toBe(list[1]!.id);
  });

  it("摘要失败重试 2 次后成功（共 3 次尝试）", async () => {
    const fake = summarizerStream(["error", "error", "LATE-SUMMARY"]);
    const plan = await planCompaction(entries(), { stream: fake.stream, signal: new AbortController().signal });
    expect(fake.calls).toBe(3);
    expect(plan!.summary).toBe("LATE-SUMMARY");
    expect(plan!.summarized).toBe(true);
  });

  it("摘要始终失败 → 硬截断最早的完整 turn", async () => {
    const fake = summarizerStream(["error", "error", "error"]);
    const plan = await planCompaction(entries(), { stream: fake.stream, signal: new AbortController().signal });
    expect(fake.calls).toBe(3);
    expect(plan!.summarized).toBe(false);
    expect(plan!.summary).toContain("硬截断");
    // findEarliestBoundary：第一个 user message（index 2）之前的两条 Entry 被硬截断
    expect(plan!.cutIndex).toBe(2);
  });

  it("无可切内容 → null", async () => {
    const { stream } = summarizerStream(["S"]);
    const plan = await planCompaction([userEntry("only"), assistantEntry("reply")], { stream, signal: new AbortController().signal });
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
    expect(view.map(item => item.id)).toEqual([c2.id, m3.id]);
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
