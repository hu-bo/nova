// §10 Sub-agent：spawn_agent 工具 + 共享并发闸门。
// 闸门本身按 taskflow.md §8.1 决策用 createFlow 实现。
import { createFlow, type Flow } from "@nova/taskflow";
import type { AgentTaskResult, AgentTool, Message, Usage } from "../types.js";
import { z } from "../tool-schema.js";

export interface ChildRunResult { text: string; transcript: Message[]; usage: Usage; output?: AgentTaskResult }
export type SpawnedRun = (args: { task: string; tools?: string[] }, signal: AbortSignal) => Promise<ChildRunResult>;
const spawnInput = z.object({
  task: z.string().trim().min(1).describe("子任务的完整描述（包含必要上下文）"),
  tools: z.array(z.string()).optional().describe("子 agent 可用的工具子集（缺省为全部）"),
});

export interface SubAgentGate { run<T>(work: () => Promise<T>): Promise<T> }

// 闸门由父 agent 与各层子 agent 共享（§10"与父 agent 共享一个信号量"）。
// flow 在任务清空后自然结束，下一次 spawn 重建新 flow。
export function createSubAgentGate(maxConcurrent: number): SubAgentGate {
  let current: { flow: Flow; exit: Promise<void> | null } | null = null;
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      if (current === null) current = { flow: createFlow({ concurrency: maxConcurrent }), exit: null };
      const active = current;
      return new Promise<T>((resolve, reject) => {
        let result: T | undefined;
        let error: unknown;
        let failed = false;
        // 先加任务再驱动调度：空 flow 一旦开始迭代就会立即结束（taskflow §4）
        active.flow.addTask({
          run: async () => {
            try { result = await work(); } catch (cause) { error = cause; failed = true; }
          },
        });
        if (active.exit === null) {
          active.exit = (async () => { for await (const _ of active.flow.run()) { /* 只驱动调度 */ } })();
          void active.exit.then(() => { if (current !== null && current.flow === active.flow) current = null; });
        }
        void active.exit.then(() => { if (failed) reject(error); else resolve(result as T); });
      });
    },
  };
}

export function spawnAgentTool(
  gate: SubAgentGate,
  runChild: SpawnedRun,
  runSignal: () => AbortSignal,
): AgentTool<{ task: string; tools?: string[] }, { transcript: Message[]; output?: AgentTaskResult }> {
  return {
    name: "spawn_agent",
    description: "派生一个子 agent 独立完成子任务并等待其结果。子任务必须自包含：子 agent 只能看到你给它的任务描述。最多 4 个并发，超出排队。",
    schema: spawnInput,
    risk: "none",
    async execute(args, ctx) {
      const result = await gate.run(() => runChild({ task: args.task, tools: args.tools }, ctx?.signal ?? runSignal()));
      return {
        status: "ok",
        content: [{ type: "text", text: result.text !== "" ? result.text : "子 agent 未产生最终回答。" }],
        details: { transcript: result.transcript, ...(result.output !== undefined ? { output: result.output } : {}) },
        usage: result.usage,
      };
    },
  };
}
