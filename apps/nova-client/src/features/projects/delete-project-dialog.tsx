import { deleteProject } from '@/api/generated/projects';
import { queryKeys } from '@/api/query-keys';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { Input } from '@/components/ui/input';
import { useIdentity } from '@/features/auth';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

export function DeleteProjectDialog({
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
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState('');
  const remove = useMutation({
    mutationFn: () => deleteProject(projectId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.projects.root(identity!.identityId) });
      void navigate({ to: '/projects' });
    },
  });
  return (
    <ConfirmationDialog
      open
      onClose={onClose}
      title="删除项目"
      subject={name}
      description="项目将从列表移除，环境绑定会失效；已有会话历史与设备文件会保留。"
      confirmLabel="删除项目"
      pendingLabel="正在删除…"
      isPending={remove.isPending}
      confirmDisabled={confirm.trim() !== name}
      error={remove.error}
      onConfirm={() => {
        if (confirm.trim() === name && !remove.isPending) remove.mutate();
      }}
    >
      <div className="space-y-2">
        <label htmlFor="delete-project-name" className="text-sm font-medium">
          输入项目名称以确认
        </label>
        <Input
          id="delete-project-name"
          autoFocus
          disabled={remove.isPending}
          value={confirm}
          autoComplete="off"
          placeholder={name}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>
    </ConfirmationDialog>
  );
}
