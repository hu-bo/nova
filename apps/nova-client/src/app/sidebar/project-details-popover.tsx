import { displayWorkspacePath } from '@/lib/workspace-path';
import { Popover } from '@base-ui/react/popover';
import { Folder, MessageCircle, Settings2 } from 'lucide-react';
import { type ReactElement } from 'react';
import type { SidebarProject } from './sidebar.types';

export function ProjectDetailsPopover({
  project,
  taskCount,
  children,
  onEdit,
}: {
  project: SidebarProject;
  taskCount: number;
  children: ReactElement;
  onEdit: () => void;
}) {
  return (
    <Popover.Root modal={false}>
      <Popover.Trigger
        render={children}
        nativeButton={false}
        role="link"
        openOnHover
        delay={250}
        closeDelay={150}
      />
      <Popover.Portal>
        <Popover.Positioner side="right" sideOffset={8} className="z-50">
          <Popover.Popup className="w-72 overflow-hidden rounded-2xl bg-white p-3 text-sm text-slate-700 shadow-xl ring-1 ring-slate-200/80">
            <div className="flex items-center gap-2 px-0.5 py-1.5 text-slate-950">
              <Folder className="size-5 shrink-0 text-slate-700" aria-hidden="true" />
              <Popover.Title className="min-w-0 truncate text-lg font-semibold">
                {project.name}
              </Popover.Title>
            </div>
            <div className="flex items-center gap-2 px-0.5 py-2.5">
              <MessageCircle className="size-5 shrink-0 text-slate-500" aria-hidden="true" />
              <span>{taskCount} 个任务</span>
            </div>
            <div className="border-t border-slate-200 py-2.5">
              <div className="flex items-start gap-2 px-0.5">
                <Folder className="mt-0.5 size-5 shrink-0 text-slate-500" aria-hidden="true" />
                <p className="min-w-0 break-all leading-5 text-slate-600">
                  {project.workspace
                    ? displayWorkspacePath(project.workspace)
                    : '尚未绑定 workspace'}
                </p>
              </div>
            </div>
            <div className="border-t border-slate-200 pt-1.5">
              <Popover.Close
                type="button"
                onClick={onEdit}
                className="flex w-full items-center gap-2 rounded-lg px-1.5 py-2 text-left font-medium text-slate-700 transition hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <Settings2 className="size-5 text-slate-500" aria-hidden="true" />
                编辑项目
              </Popover.Close>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
