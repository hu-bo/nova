import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Folder, MessageCircle, Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { displayWorkspacePath } from "../lib/workspace-path.js";

export interface ProjectDetailsPopoverProps {
  project: {
    name: string;
    workspace: string | null;
  };
  taskCount: number;
  children: ReactNode;
  onEdit: () => void;
}

/** Shows project details and actions without making the sidebar row wider. */
export function ProjectDetailsPopover({ project, taskCount, children, onEdit }: ProjectDetailsPopoverProps) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        render={<div className="min-w-0" />}
        nativeButton={false}
        openOnHover
        delay={250}
        closeDelay={150}
      >
        {children}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner side="right" align="start" sideOffset={8} className="z-50">
          <PopoverPrimitive.Popup
            aria-label={`${project.name} 的项目详情`}
            className="w-72 overflow-hidden rounded-2xl bg-white p-3 text-sm text-slate-700 shadow-xl ring-1 ring-slate-200/80 transition-[transform,scale,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0"
          >
            <div className="flex items-center gap-2 px-0.5 py-1.5 text-slate-950">
              <Folder className="size-5 shrink-0 text-slate-700" aria-hidden="true" />
              <p className="min-w-0 truncate text-lg font-semibold">{project.name}</p>
            </div>
            <div className="flex items-center gap-2 px-0.5 py-2.5">
              <MessageCircle className="size-5 shrink-0 text-slate-400" aria-hidden="true" />
              <span>{taskCount} 个任务</span>
            </div>
            <div className="border-t border-slate-200 py-2.5">
              <div className="flex items-start gap-2 px-0.5">
                <Folder className="mt-0.5 size-5 shrink-0 text-slate-400" aria-hidden="true" />
                <p className="min-w-0 break-all leading-5 text-slate-600">
                  {project.workspace ? displayWorkspacePath(project.workspace) : "尚未绑定 workspace"}
                </p>
              </div>
            </div>
            <div className="border-t border-slate-200 pt-1.5">
              <button
                type="button"
                onClick={onEdit}
                className="flex w-full items-center gap-2 rounded-lg px-1.5 py-2 text-left font-medium text-slate-700 transition hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <Settings2 className="size-5 text-slate-400" aria-hidden="true" />
                编辑项目
              </button>
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
