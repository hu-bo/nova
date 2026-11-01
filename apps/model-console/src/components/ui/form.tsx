import {
  FieldError as HeroUIFieldError,
  Input as HeroUIInput,
  Label as HeroUILabel,
  ListBox as HeroUIListBox,
  Select as HeroUISelect,
  TextField as HeroUITextField,
} from "@heroui/react";
import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";

/** Legacy form primitives — thin re-export of HeroUI v3 components.
 *
 * The migration strategy:
 *  - FieldLabel renders a HeroUI `<Label>` with optional hint and inline error.
 *  - Input wraps HeroUI `<Input>` for use inside a TextField (no Label).
 *  - Select wraps HeroUI `<Select>` compound (`Select.Trigger`/`Select.Popover`/`ListBox`/`ListBox.Item`).
 *
 * For form fields, callers should compose these inside a HeroUI `<TextField>` to get error/description slots.
 */

export interface FieldLabelProps {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}

export function FieldLabel({ label, hint, error, children }: FieldLabelProps) {
  return (
    <HeroUILabel
      data-slot="field-label"
      className="flex w-full min-w-0 flex-col items-stretch gap-1.5 text-xs font-medium text-foreground"
    >
      <span>
        {label}
        {hint && <span className="ml-1.5 font-normal text-muted-foreground">{hint}</span>}
      </span>
      {children}
      {error && (
        <HeroUIFieldError className="mt-1.5 block text-xs font-medium text-danger" data-slot="field-error">
          {error}
        </HeroUIFieldError>
      )}
    </HeroUILabel>
  );
}

export function Input({ className, ...props }: ComponentProps<typeof HeroUIInput>) {
  return <HeroUIInput data-slot="input" className={cn("w-full min-w-0", className)} {...props} />;
}

/** Legacy native select — still used in many places (date pickers etc).
 *  Kept as a thin pass-through so RHF `register()` continues to work unchanged. */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "flex h-10 w-full rounded-xl border border-field-border bg-field-background px-3 py-2 text-sm text-field-foreground shadow-xs outline-none transition",
        "focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus/30",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/** HeroUI compound Select — use when migrating to the v3 API.
 *
 * Example:
 * ```tsx
 * <Select value={value} onChange={setValue}>
 *   <Select.Trigger>
 *     <Select.Value />
 *     <Select.Indicator />
 *   </Select.Trigger>
 *   <Select.Popover>
 *     <ListBox>
 *       <ListBox.Item id="a">A</ListBox.Item>
 *       <ListBox.Item id="b">B</ListBox.Item>
 *     </ListBox>
 *   </Select.Popover>
 * </Select>
 * ```
 */
export { HeroUISelect as Select, HeroUIListBox as ListBox, HeroUITextField as TextField };

/** Helper for composing an Input + Label + Error inside a TextField wrapper. */
export { HeroUITextField as FormField, HeroUIInput as FieldInput, HeroUIFieldError as FormFieldError };
