import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useNavigate } from '@tanstack/react-router';
import { Terminal } from 'lucide-react';

/** 项目未绑定执行环境时的发送拦截（参考 conversation.tsx L484-502）。 */
export function UnboundDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader icon={<Terminal />}>
          <DialogTitle>先绑定项目环境</DialogTitle>
          <DialogDescription>项目会话需要明确的执行环境后才能处理这条消息。</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm leading-6 text-muted-foreground">
            这条消息尚未发送，草稿已保留。完成项目环境绑定后，回到此会话重新发送；不会降级成普通会话。
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onPress={onClose}>
            先不发送
          </Button>
          <Button onPress={() => void navigate({ to: '/projects/$id', params: { id: projectId } })}>
            去绑定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
