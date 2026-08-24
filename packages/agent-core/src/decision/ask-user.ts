// §6 反问触发点：内置 ask_user —— agent-core 注册，不在 packages/tools。
// 与审批共用一套 Decision 挂起/恢复（requestDecision）。
import type { AgentTool } from "../types.js";
import { z } from "../tool-schema.js";

export interface AskInput {
  question: string;
  options?: string[];
  multiSelect?: boolean;
}
const askInput = z.object({
  question: z.string().trim().min(1).describe("要问用户的问题"),
  options: z.array(z.string()).optional().describe("候选选项（可选）"),
  multiSelect: z.boolean().optional().describe("是否允许多选"),
});

export function askUserTool(
  ask: (question: AskInput, signal: AbortSignal) => Promise<string[] | "aborted" | null>,
  runSignal: () => AbortSignal,
): AgentTool<AskInput, { answers: string[] } | null> {
  return {
    name: "ask_user",
    description: "向用户提问并等待回答。只用于确实需要用户决策、你无法自行判断的情况；能自己判断的不要问。",
    schema: askInput,
    risk: "none",
    async execute(args, ctx) {
      const answers = await ask(
        { question: args.question, options: args.options, multiSelect: args.multiSelect },
        ctx?.signal ?? runSignal(),
      );
      if (answers === "aborted")
        return { status: "error", content: [{ type: "text", text: "提问被中断，未获得回答。" }], details: null };
      if (answers === null)
        return {
          status: "error",
          content: [{ type: "text", text: "用户未在限定时间内回答，请基于已有信息继续。" }],
          details: null,
        };
      return {
        status: "ok",
        content: [{ type: "text", text: answers.map((answer) => `- ${answer}`).join("\n") }],
        details: { answers },
      };
    },
  };
}
