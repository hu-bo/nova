// §4.2 Tool Batch —— 并发调度复用 @nova/taskflow（taskflow.md §8.1 决策）：
// 一个 tool call 一个 task；sequential tool 独占、写文件按路径串行，都用 deps 表达；
// 并发上限 = toolConcurrency（一个信号量）；结果按原始顺序回填。
import { createFlow } from "@nova/taskflow";
import type { AgentTool, ContentPart, Risk, ToolCall, ToolContext, Usage } from "../types.js";
import { truncateContent } from "../context/truncate.js";
import type { ApprovalOutcome } from "../decision/decision.js";

export interface ToolOutcome {
  callId: string;
  name: string;
  status: "ok" | "error";
  content: ContentPart[];   // 已截断
  details: unknown;
  terminate: boolean;
  executed: boolean;        // false = 未真正执行（未知工具 / 被拒 / 中断），结果是合成的 error
  usage?: Usage;
}

export interface BatchDeps {
  tools: ReadonlyMap<string, AgentTool>;
  ctx: ToolContext | undefined;
  concurrency: number;
  signal: AbortSignal;
  approve(call: ToolCall & { risk: Risk }): Promise<ApprovalOutcome | "aborted">;
  onToolStart(call: ToolCall): Promise<void>;
  onToolEnd(call: ToolCall, outcome: ToolOutcome): Promise<void>;
}

export async function runToolBatch(calls: ToolCall[], deps: BatchDeps): Promise<ToolOutcome[]> {
  if (calls.length === 0) return [];
  const outcomes = new Map<string, ToolOutcome>();
  const flow = createFlow({ concurrency: deps.concurrency });
  // abort 后不再启动新 task；已启动的经 tool ctx.signal 收敛（§4.2）
  const onAbort = () => { flow.cancel(); };
  deps.signal.addEventListener("abort", onAbort, { once: true });

  let lastSequential: string | null = null;
  const lastWriteByPath = new Map<string, string>();
  const seen: string[] = [];

  for (const call of calls) {
    const tool = deps.tools.get(call.name);
    const taskId = `call-${call.callId}`;
    const taskDeps: string[] = [];

    let risk: Risk = "exec";
    if (tool) {
      risk = tool.risk ?? "exec";
      if (tool.executionMode === "sequential") {
        // sequential tool 独占：等前面所有 task，后面的 task 也都等它
        taskDeps.push(...seen);
        lastSequential = taskId;
      } else if (lastSequential !== null) {
        taskDeps.push(lastSequential);
      }
      // risk "write" 按路径串行：同路径不并发（§4.2）
      if (risk === "write") {
        const path = writePathOf(call.args);
        const previous = lastWriteByPath.get(path);
        if (previous) taskDeps.push(previous);
        lastWriteByPath.set(path, taskId);
      }
    }
    seen.push(taskId);

    flow.addTask({
      id: taskId,
      deps: taskDeps,
      run: async () => { outcomes.set(call.callId, await runOne(call, tool, risk, deps)); },
    });
  }

  for await (const _ of flow.run()) { /* tool.start/tool.end 已在回调里外发，这里只驱动调度 */ }
  deps.signal.removeEventListener("abort", onAbort);

  // 每个 tool_call 都必须有对应 tool_result（provider 契约）：被取消/未启动的补 error 结果
  return calls.map((call): ToolOutcome => outcomes.get(call.callId) ?? {
    callId: call.callId,
    name: call.name,
    status: "error",
    content: [{ type: "text", text: "tool call was not executed (run aborted)" }],
    details: null,
    terminate: false,
    executed: false,
  });
}

async function runOne(call: ToolCall, tool: AgentTool | undefined, risk: Risk, deps: BatchDeps): Promise<ToolOutcome> {
  const fail = (text: string): ToolOutcome => ({
    callId: call.callId,
    name: call.name,
    status: "error",
    content: [{ type: "text", text }],
    details: null,
    terminate: false,
    executed: false,
  });

  if (!tool) return fail(`unknown tool: ${call.name}`);
  if (deps.signal.aborted) return fail("tool call was not executed (run aborted)");

  const parsed = tool.schema.safeParse(call.args);
  if (!parsed.success) return fail(`invalid arguments: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ")}`);

  const approval = await deps.approve({ ...call, risk });
  if (approval === "aborted") return fail("tool call was not executed (run aborted)");
  if (!approval.allowed) {
    // §6：拒绝必须让模型知道，否则它会反复重试同一个操作
    return fail(`denied by user: ${call.name}`);
  }

  await deps.onToolStart(call);

  try {
    const toolCtx = deps.ctx ? withSignal(deps.ctx, deps.signal) : undefined;
    const result = await tool.execute(parsed.data, toolCtx);
    return await end({
      callId: call.callId,
      name: call.name,
      status: result.status,
      content: truncateContent(result.content),
      details: result.details,
      terminate: result.terminate ?? false,
      executed: true,
      ...(result.usage ? { usage: result.usage } : {}),
    });
  } catch (error) {
    // §3.3：AgentTool.execute 可以 throw —— 转成 error tool_result 喂回模型自行纠错
    const outcome = fail(error instanceof Error ? error.message : String(error));
    outcome.executed = true;
    return await end(outcome);
  }

  async function end(outcome: ToolOutcome): Promise<ToolOutcome> {
    await deps.onToolEnd(call, outcome);
    return outcome;
  }
}

function writePathOf(args: unknown): string {
  if (args && typeof args === "object" && typeof (args as { path?: unknown }).path === "string") {
    return (args as { path: string }).path;
  }
  return JSON.stringify(args);
}

function withSignal(ctx: ToolContext, signal: AbortSignal): ToolContext {
  // run 级 abort 必须能中止 tool；ctx 自带的 signal（如外部 controller）保持生效。
  // 组合 signal 经 ExecOptions.signal 显式传给 exec：实现侧的 exec 多是闭包，
  // 只改 ctx.signal 属性管不到闭包捕获的旧对象。
  if (ctx.signal === signal) return ctx;
  const composed = AbortSignal.any([ctx.signal, signal]);
  return { ...ctx, signal: composed, exec: (command, options) => ctx.exec(command, { ...options, signal: composed }) };
}
