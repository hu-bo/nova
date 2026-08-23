import { ChevronRight, ListTodo } from "lucide-react";
import type { Todo } from "@nova/protocol";
import { TodoList } from "./blocks/todo.js";
import { Card } from "./components/ui/card.js";

export function TodoPanel({ items, collapsed = false }: { items: Todo[]; collapsed?: boolean | undefined }) {
  const remaining = items.filter(item => item.status !== "completed").length;
  const completed = items.length - remaining;
  const progress = items.length ? Math.round((completed / items.length) * 100) : 0;

  return (
    <Card className="nova-todo-panel overflow-hidden">
      <details className="group" open={!collapsed}>
        <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 outline-none transition-colors select-none hover:bg-slate-50 focus-visible:bg-slate-50 dark:hover:bg-slate-900 dark:focus-visible:bg-slate-900 [&::-webkit-details-marker]:hidden">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100 dark:bg-indigo-950/50 dark:text-indigo-300 dark:ring-indigo-900"><ListTodo className="size-4" aria-hidden="true" /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-slate-800 dark:text-slate-200">当前计划</span>
            <span className="mt-0.5 block text-[11px] text-slate-400">{remaining} 项未完成 · {progress}%</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-slate-400 transition-transform duration-200 group-open:rotate-90" aria-hidden="true" />
        </summary>
        <div className="nova-todo-progress mx-3 mb-1" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
        <div className="border-t border-slate-100 px-1 py-1 dark:border-slate-800"><TodoList items={items} /></div>
      </details>
    </Card>
  );
}
