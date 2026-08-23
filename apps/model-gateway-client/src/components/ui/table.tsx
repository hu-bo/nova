import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Table({ className, ...props }: ComponentProps<"table">) {
  return <div data-slot="table-container" className="overflow-x-auto rounded-xl bg-card ring-1 ring-slate-200 shadow-soft"><table className={cn("w-full text-left", className)} {...props} /></div>;
}
export function TableHeader(props: ComponentProps<"thead">) {
  return <thead className="bg-slate-50/80 text-xs font-semibold uppercase tracking-wide text-slate-500" {...props} />;
}
export function TableBody(props: ComponentProps<"tbody">) {
  return <tbody className="divide-y divide-slate-100" {...props} />;
}
export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("transition-colors hover:bg-slate-50/70", className)} {...props} />;
}
export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return <th className={cn("px-5 py-3 font-semibold", className)} {...props} />;
}
export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-5 py-4 align-middle text-sm text-slate-600", className)} {...props} />;
}
