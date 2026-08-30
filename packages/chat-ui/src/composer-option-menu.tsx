import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import type { ComposerOption } from "./composer-types.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";

export function ComposerOptionMenu({
  label,
  value,
  options,
  disabled,
  icon,
  onChange,
}: {
  label: string;
  value?: string | undefined;
  options: readonly ComposerOption[];
  disabled: boolean;
  icon: ReactNode;
  onChange?: ((value: string) => void) | undefined;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <DropdownMenu disabled={disabled || !onChange}>
      <DropdownMenuTrigger
        aria-label={label}
        className="inline-flex h-8 max-w-40 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-500 outline-none transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-3 focus-visible:ring-indigo-500/20 disabled:pointer-events-none disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
      >
        {icon}
        <span className="truncate">{selected?.label ?? label}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange?.(String(next))}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
