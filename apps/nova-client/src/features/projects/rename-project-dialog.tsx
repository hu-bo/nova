import { updateProject } from '@/api/generated/projects';
import { queryKeys } from '@/api/query-keys';
import { ErrorNotice } from '@/components/error-notice';
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
import { Input } from '@/components/ui/input';
import { useIdentity } from '@/features/auth';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useState } from 'react';

export function RenameProjectDialog({
  projectId,
  name,
  onClose,
}: {
  projectId: string;
  name: string;
  onClose: () => void;
}) {
  const { identity } = useIdentity();
  const client = useQueryClient();
  const [next, setNext] = useState(name);
  const save = useMutation({
    mutationFn: () => updateProject(projectId, { name: next.trim() }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.projects.root(identity!.identityId) });
      onClose();
    },
  });
  const valid = next.trim().length > 0 && next.trim().length <= 200;
  return (
    <Dialog
      open
      isPending={save.isPending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent closeDisabled={save.isPending}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <DialogHeader icon={<Pencil />}>
            <DialogTitle>重命名项目</DialogTitle>
            <DialogDescription>为这个项目设置一个清楚的名字。</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <Input
              autoFocus
              aria-label="项目名称"
              value={next}
              maxLength={200}
              onChange={(event) => setNext(event.target.value)}
            />
            {save.error && <ErrorNotice error={save.error} />}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={save.isPending} onPress={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={save.isPending || !valid}>
              {save.isPending ? '正在保存…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
