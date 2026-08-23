import { AlertTriangle, Check, Circle, LoaderCircle } from "lucide-react";
import type { Todo } from "@nova/protocol";

const statusView = {
  pending: { label: "待处理", Icon: Circle, iconClass: "text-slate-300 dark:text-slate-600" },
  in_progress: { label: "进行中", Icon: LoaderCircle, iconClass: "animate-spin text-indigo-500 motion-reduce:animate-none" },
  completed: { label: "已完成", Icon: Check, iconClass: "rounded-full bg-emerald-500 p-0.5 text-white" },
  blocked: { label: "已阻塞", Icon: AlertTriangle, iconClass: "text-amber-500" },
} satisfies Record<Todo["status"], { label: string; Icon: typeof Circle; iconClass: string }>;

export function TodoList({ items }: { items: Todo[] }) {
  if (items.length === 0) return <p className="m-0 py-2 text-sm text-slate-400">暂无计划项</p>;
  return (
    <ul className="nova-todo-list m-0 grid list-none gap-1 p-0">
      {items.map(item => {
        const { label, Icon, iconClass } = statusView[item.status];
        return (
          <li key={item.id} data-status={item.status} className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-2 rounded-lg px-2 py-1.5">
            <Icon className={`mt-0.5 size-4 ${iconClass}`} aria-hidden="true" />
            <span className="min-w-0">
              <span className={`block text-sm leading-5 ${item.status === "completed" ? "text-slate-400 line-through" : "text-slate-700 dark:text-slate-300"}`}>{item.text}</span>
              {item.note && <small className="mt-0.5 block text-xs leading-5 text-slate-400">{item.note}</small>}
              <span className="sr-only">{label}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
