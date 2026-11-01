import { Modal as HeroUIModal } from "@heroui/react";
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

const sizes = { sm: "sm", md: "md", lg: "lg" } as const;

export function Dialog({ open, title, description, children, onClose, size = "md", closeLabel = "关闭" }: DialogProps) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const initialFocusTargetRef = useRef<HTMLElement | null>(null);

  // Remember the element that opened the dialog so focus can return to it on close.
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

  // After mount, find the element marked with data-initial-focus inside children
  // and set autoFocus via initialFocus ref if available. HeroUI Modal doesn't
  // expose a custom initialFocus prop, but it does honor `autoFocus` on the
  // first focusable element. We rely on consumer's `autoFocus` on inputs.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const target = document.querySelector<HTMLElement>("[data-initial-focus]");
      if (target) initialFocusTargetRef.current = target;
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  return (
    <HeroUIModal.Backdrop
      isOpen={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      variant="blur"
    >
      <HeroUIModal.Container size={sizes[size]}>
        <HeroUIModal.Dialog className="min-w-0 max-w-full bg-surface text-surface-foreground">
          <HeroUIModal.Header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <HeroUIModal.Heading className="text-lg font-semibold text-foreground">{title}</HeroUIModal.Heading>
              {description && <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>}
            </div>
            <HeroUIModal.CloseTrigger
              aria-label={closeLabel}
              className={cn(
                "rounded-lg p-2 text-muted-foreground outline-none transition",
                "hover:bg-muted hover:text-foreground",
                "focus-visible:ring-2 focus-visible:ring-focus/40",
              )}
            >
              <X className="size-5" aria-hidden="true" />
            </HeroUIModal.CloseTrigger>
          </HeroUIModal.Header>
          <HeroUIModal.Body className="max-h-[min(76vh,820px)] min-w-0 overflow-y-auto px-5 py-4" data-dialog-body>
            {children}
          </HeroUIModal.Body>
        </HeroUIModal.Dialog>
      </HeroUIModal.Container>
    </HeroUIModal.Backdrop>
  );
}
