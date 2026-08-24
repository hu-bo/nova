import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface DialogProps {
  open: boolean;
  title: string;
  description?: string | undefined;
  children: ReactNode;
  onClose: () => void;
  size?: "sm" | "md" | "lg";
  closeLabel?: string;
}

const sizes = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-4xl" };

export function Dialog({ open, title, description, children, onClose, size = "md", closeLabel = "关闭" }: DialogProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) return;

    const rememberPointerTarget = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      returnFocusRef.current = event.target.closest<HTMLElement>(
        "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
    };
    const rememberKeyboardTarget = () => {
      if (document.activeElement instanceof HTMLElement) returnFocusRef.current = document.activeElement;
    };

    document.addEventListener("pointerdown", rememberPointerTarget, true);
    document.addEventListener("keydown", rememberKeyboardTarget, true);
    return () => {
      document.removeEventListener("pointerdown", rememberPointerTarget, true);
      document.removeEventListener("keydown", rememberKeyboardTarget, true);
    };
  }, [open]);

  const initialFocus = () =>
    popupRef.current?.querySelector<HTMLElement>("[data-initial-focus]") ??
    popupRef.current?.querySelector<HTMLElement>(
      "[data-dialog-body] input:not([type='hidden']):not([disabled]), [data-dialog-body] select:not([disabled]), [data-dialog-body] textarea:not([disabled]), [data-dialog-body] button:not([disabled])",
    ) ??
    null;
  const finalFocus = () => {
    const element = returnFocusRef.current;
    returnFocusRef.current = null;
    return element?.isConnected ? element : null;
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
          <DialogPrimitive.Popup
            ref={popupRef}
            initialFocus={initialFocus}
            finalFocus={finalFocus}
            className={cn(
              "relative w-full overflow-hidden rounded-2xl bg-card text-card-foreground shadow-2xl ring-1 ring-slate-200 transition duration-200 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
              sizes[size],
            )}
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
              <div>
                <DialogPrimitive.Title className="text-lg font-semibold text-slate-900">{title}</DialogPrimitive.Title>
                {description && (
                  <DialogPrimitive.Description className="mt-1 text-sm leading-6 text-slate-500">
                    {description}
                  </DialogPrimitive.Description>
                )}
              </div>
              <DialogPrimitive.Close
                aria-label={closeLabel}
                className="rounded-lg p-2 text-slate-400 outline-none transition hover:bg-muted hover:text-slate-700 focus-visible:ring-3 focus-visible:ring-ring/40"
              >
                <X className="size-5" aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>
            <div data-dialog-body className="max-h-[min(76vh,820px)] overflow-y-auto px-6 py-5">
              {children}
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
