import { AlertTriangle, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  danger = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      size="sm"
      onClose={() => {
        if (!pending) onClose();
      }}
    >
      <div
        className={`flex gap-3 rounded-xl p-4 ring-1 ${danger ? "bg-danger/10 text-danger ring-danger/30" : "bg-warning/10 text-warning-foreground ring-warning/30"}`}
      >
        <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <p className="text-sm leading-6">此操作会立即影响后续模型配置，请确认当前资源与影响范围。</p>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <Button type="button" onPress={onClose} isDisabled={pending}>
          取消
        </Button>
        <Button type="button" variant={danger ? "danger" : "primary"} onPress={onConfirm} isDisabled={pending}>
          {pending && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
          {pending ? "正在处理" : confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
