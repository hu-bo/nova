import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  size?: "sm" | "md" | "lg" | "xl";
  placement?: "center" | "left";
}

const sizes = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl", xl: "max-w-6xl" };

export function Dialog({
  open,
  title,
  description,
  children,
  onClose,
  size = "md",
  placement = "center",
}: DialogProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) return;
    const remember = (event: PointerEvent) => {
      if (event.target instanceof Element) {
        returnFocusRef.current = event.target.closest<HTMLElement>("button, a[href], input, select, textarea");
      }
    };
    document.addEventListener("pointerdown", remember, true);
    return () => document.removeEventListener("pointerdown", remember, true);
  }, [open]);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-[2px] transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <DialogPrimitive.Viewport
          className={cn(
            "fixed inset-0 z-50 flex overflow-y-auto",
            placement === "left" ? "items-stretch justify-start p-0" : "items-center justify-center p-4",
          )}
        >
          <DialogPrimitive.Popup
            ref={popupRef}
            initialFocus={() =>
              popupRef.current?.querySelector<HTMLElement>(
                "[data-initial-focus], input:not([disabled]), select:not([disabled]), button:not([disabled])",
              ) ?? null
            }
            finalFocus={() => (returnFocusRef.current?.isConnected ? returnFocusRef.current : null)}
            className={cn(
              "relative w-full overflow-hidden bg-white text-slate-900 shadow-2xl ring-1 ring-slate-200 transition",
              placement === "left"
                ? "flex h-dvh max-h-none w-[min(92vw,480px)] flex-col rounded-none rounded-r-2xl data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full"
                : `rounded-2xl data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 ${sizes[size]}`,
            )}
          >
            <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
              <div>
                <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
                {description && (
                  <DialogPrimitive.Description className="mt-1 text-sm leading-6 text-slate-500">
                    {description}
                  </DialogPrimitive.Description>
                )}
              </div>
              <DialogPrimitive.Close
                aria-label="关闭"
                className="rounded-lg p-2 text-slate-400 outline-none transition hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <X className="size-5" aria-hidden="true" />
              </DialogPrimitive.Close>
            </header>
            <div
              className={cn(
                "overflow-y-auto px-6 py-5",
                placement === "left" ? "min-h-0 flex-1" : "max-h-[min(80vh,900px)]",
              )}
            >
              {children}
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
