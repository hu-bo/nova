import { Menu } from "@base-ui/react/menu";
import { Check } from "lucide-react";
import { cn } from "../../lib/cn.js";

const DropdownMenu = Menu.Root;
const DropdownMenuTrigger = Menu.Trigger;
const DropdownMenuRadioGroup = Menu.RadioGroup;

function DropdownMenuContent({ className, sideOffset = 6, align = "start", ...props }: Menu.Popup.Props & { sideOffset?: number; align?: Menu.Positioner.Props["align"] }) {
  return (
    <Menu.Portal>
      <Menu.Positioner sideOffset={sideOffset} align={align} className="z-50 outline-none">
        <Menu.Popup data-slot="dropdown-menu-content" className={cn("min-w-40 origin-[var(--transform-origin)] rounded-lg bg-white p-1 text-slate-700 shadow-lg ring-1 ring-slate-200 transition-[transform,scale,opacity] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 dark:bg-slate-950 dark:text-slate-200 dark:ring-slate-800", className)} {...props} />
      </Menu.Positioner>
    </Menu.Portal>
  );
}

function DropdownMenuRadioItem({ className, children, ...props }: Menu.RadioItem.Props) {
  return (
    <Menu.RadioItem data-slot="dropdown-menu-radio-item" closeOnClick className={cn("relative flex min-h-8 cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-2 text-xs outline-none data-disabled:pointer-events-none data-disabled:opacity-40 data-highlighted:bg-slate-100 data-highlighted:text-slate-950 dark:data-highlighted:bg-slate-800 dark:data-highlighted:text-white", className)} {...props}>
      <span className="absolute left-2 grid size-4 place-items-center"><Menu.RadioItemIndicator><Check className="size-3.5 text-indigo-600" aria-hidden="true" /></Menu.RadioItemIndicator></span>
      {children}
    </Menu.RadioItem>
  );
}

export { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger };
