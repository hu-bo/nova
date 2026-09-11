// system prompt 组装。§9.4：TODO 的判定标准属于 prompt 层（判定不写成代码），
// 代码只负责保活与注入（context/todo.ts）。
import type { PromptAsset } from "../types.js";

export const BASE_SYSTEM_PROMPT = `你是 Nova agent，通过"计划 → 执行 → 观察 → 验证 → 结果"的循环完成任务：
- 危险操作被拒绝时不要反复重试同一操作：换一条路，或向用户说明。
- 结论基于事实；不知道就先用工具查，查不到就明说。
- 已满足用户目标时立即结束；不得重复已经给出的结论、标题或依据来凑篇幅。`;

// §9.2 什么算 TODO —— 判据写进 system prompt，由模型自己决定何时调 todo_write
export const TODO_CRITERIA = `## TODO 维护标准
用 todo_write 维护任务清单。一个事项同时满足两条才算 TODO：
1. 需要一个未来动作才能完成；
2. 这个动作不是当前这轮回答本身。
复杂 ≠ TODO：判据是"回答完还有没有后续动作"。单轮问答、以及复杂但本轮就做完的事，都不进 TODO。
多步任务（≥2 个未来动作）开始时就 todo_write 建清单；每个事项的 id 必须使用 todo- 前缀；每完成一项立即勾选，不攒到最后一起勾；遇到阻塞标 blocked 并写明卡在哪。`;

export function assembleSystem(userId: string, assets?: PromptAsset[]): string {
  const parts = [BASE_SYSTEM_PROMPT, TODO_CRITERIA, `当前用户：${userId}`];
  for (const asset of assets ?? []) parts.push(asset.content);
  return parts.join("\n\n");
}
