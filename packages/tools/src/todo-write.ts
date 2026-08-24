import { text, type Tool, z } from "./shared.js";

const todoItem = z.object({
  id: z.string().regex(/^todo-.+$/, "todo id must start with todo-"),
  text: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed", "blocked"]),
  note: z.string().optional().describe("Required for blocked items: what it is blocked on"),
});
const schema = z.object({ items: z.array(todoItem) }).check(({ value: { items }, issues }) => {
  const seen = new Set<string>();
  let inProgress = 0;
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id))
      issues.push({
        input: item.id,
        code: "custom",
        path: ["items", index, "id"],
        message: `duplicate id: ${item.id}`,
      });
    seen.add(item.id);
    if (item.status === "blocked" && !item.note)
      issues.push({
        input: item,
        code: "custom",
        path: ["items", index, "note"],
        message: "blocked item must have a note",
      });
    if (item.status === "in_progress") inProgress += 1;
  }
  if (inProgress > 1)
    issues.push({ input: items, code: "custom", path: ["items"], message: "at most one item can be in_progress" });
});

export const todoWrite: Tool<z.output<typeof schema>> = {
  name: "todo_write",
  description: "Replace the entire TODO list. Pass the full list every time, not a patch.",
  schema,
  risk: "none",
  async execute({ items }) {
    const completed = items.filter((item) => item.status === "completed").length;
    return {
      status: "ok",
      content: text(`TODO: ${items.length - completed} 未完成 / ${completed} 已完成`),
      details: { items },
    };
  },
};
