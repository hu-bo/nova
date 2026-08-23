// §9.4 保活与注入 —— 代码只保证"模型永远看得见当前 TODO"；判定标准在 prompt（prompts/todo.md 的内容）。
// TodoState 不是 Entry：压缩完全不动它。唯一写入点是 todo_write 成功结果（loop 里接线）。
import type { Todo, TodoState } from "../types.js";

export const TODO_SUGGEST = 2;   // 未完成项 ≥ 2：建议维护
export const TODO_ENFORCE = 3;   // 未完成项 ≥ 3：强制注入上下文

export function unfinishedCount(state: TodoState | null): number {
  if (!state) return 0;
  return state.items.filter(item => item.status !== "completed").length;
}

// 注入位置：紧邻最后一条 user message 之前（assemble 里落位）。
// ≥ ENFORCE：markdown 清单全列未完成项；≥ SUGGEST：一句话提醒；低于阈值不注入。
export function renderTodoInjection(state: TodoState | null): string | null {
  const unfinished = unfinishedCount(state);
  if (unfinished === 0 || !state) return null;
  if (unfinished < TODO_SUGGEST) return null;
  if (unfinished < TODO_ENFORCE) {
    return `提醒：当前有 ${unfinished} 项未完成 TODO，推进时请用 todo_write 及时勾选或更新状态。`;
  }
  const completed = state.items.filter(item => item.status === "completed").length;
  const lines = state.items
    .filter(item => item.status !== "completed")
    .map(item => {
      const mark = item.status === "in_progress" ? "~" : item.status === "blocked" ? "!" : " ";
      const note = item.status === "blocked" && item.note ? ` —— 阻塞：${item.note}` : "";
      return `- [${mark}] ${item.text}${note}`;
    });
  return `## 当前 TODO（已完成 ${completed} 项）\n${lines.join("\n")}`;
}

export function toTodoState(items: Todo[]): TodoState {
  return { items: items.map(item => ({ ...item })), updatedAt: Date.now() };
}
