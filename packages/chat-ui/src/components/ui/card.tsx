import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card" className={cn("flex flex-col rounded-xl bg-white text-slate-950 shadow-sm ring-1 ring-slate-200/80 dark:bg-slate-950 dark:text-slate-50 dark:ring-slate-800", className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("grid gap-1 px-3 pt-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-title" className={cn("font-semibold leading-none text-slate-900 dark:text-slate-100", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-description" className={cn("text-sm leading-5 text-slate-500 dark:text-slate-400", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-3 pb-3", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("flex items-center px-3 pb-3", className)} {...props} />;
}
