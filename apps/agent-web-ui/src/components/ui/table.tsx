import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="overflow-x-auto">
      <table className={cn("w-full text-left text-sm", className)} {...props} />
    </div>
  );
}
export function TableHeader(props: ComponentProps<"thead">) {
  return <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500" {...props} />;
}
export function TableBody(props: ComponentProps<"tbody">) {
  return <tbody className="divide-y divide-slate-100" {...props} />;
}
export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("transition-colors hover:bg-slate-50/80", className)} {...props} />;
}
export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return <th className={cn("px-4 py-3 font-semibold", className)} {...props} />;
}
export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-4 py-3.5 align-middle text-slate-600", className)} {...props} />;
}
