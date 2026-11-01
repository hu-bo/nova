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
      <DropdownMenuTrigger aria-label={label} className="nova-composer-option-trigger">
        <span className="nova-composer-option-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="nova-composer-option-label">{selected?.label ?? label}</span>
        <ChevronDown className="nova-composer-option-chevron" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange?.(String(next))}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.description ? (
                <span className="grid min-w-0 gap-0.5">
                  <span>{option.label}</span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">{option.description}</span>
                </span>
              ) : (
                option.label
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
