import { AlertTriangle, LoaderCircle } from "lucide-react";
import { Button } from "./ui/button.js";
import { Dialog } from "./ui/dialog.js";

export function ConfirmDialog({ open, title, description, confirmLabel, pending = false, danger = false, onConfirm, onClose }: { open: boolean; title: string; description: string; confirmLabel: string; pending?: boolean; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog open={open} title={title} description={description} size="sm" onClose={() => { if (!pending) onClose(); }}>
      <div className={`flex gap-3 rounded-xl p-4 ring-1 ${danger ? "bg-rose-50 text-rose-800 ring-rose-200" : "bg-amber-50 text-amber-800 ring-amber-200"}`}>
        <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <p className="text-sm leading-6">此操作会立即影响后续模型配置，请确认当前资源与影响范围。</p>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <Button type="button" onClick={onClose} disabled={pending}>取消</Button>
        <Button type="button" variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={pending} icon={pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : undefined}>{pending ? "正在处理" : confirmLabel}</Button>
      </div>
    </Dialog>
  );
}
