import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export const fieldClass =
  "mt-2 w-full rounded-xl bg-white px-3 py-2.5 text-sm text-slate-900 ring-1 ring-inset ring-slate-200 transition placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-100 disabled:text-slate-500";

export function FieldLabel({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm font-medium text-slate-700">
      <span>{label}</span>
      {hint && <span className="ml-2 font-normal text-slate-400">{hint}</span>}
      {children}
      {error && (
        <span role="alert" className="mt-1.5 block text-xs font-medium text-rose-600">
          {error}
        </span>
      )}
    </label>
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${fieldClass} ${className}`} {...props} />;
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${fieldClass} ${className}`} {...props} />;
}

export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${fieldClass} min-h-24 resize-y ${className}`} {...props} />;
}
